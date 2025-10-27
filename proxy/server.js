import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { DatabaseSync } from "node:sqlite";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_DEFAULT_VERSION = "2023-06-01";
const WEBSOCKET_READY_STATE_OPEN = 1;

class ClaudeCodeTracer {
  constructor(config = {}) {
    this.port = Number(config.port || 3000);
    this.uiPort = Number(config.uiPort || 3001);
    this.wsPort = this.port + 2;
    this.app = express();
    this.db = new DatabaseSync(config.dbPath || "traces.db");
    this.sessions = new Map();
    this.clients = new Set();
    this.setupDatabase();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  setupDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        project_name TEXT,
        total_requests INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        timestamp INTEGER NOT NULL,
        method TEXT,
        endpoint TEXT,
        headers TEXT,
        body TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        status INTEGER,
        headers TEXT,
        body TEXT,
        latency INTEGER,
        tokens_used INTEGER,
        FOREIGN KEY (request_id) REFERENCES requests(id)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input TEXT,
        output TEXT,
        timestamp INTEGER,
        FOREIGN KEY (request_id) REFERENCES requests(id)
      )
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id)`
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp)`
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_responses_request ON responses(request_id)`
    );
  }

  setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json({ limit: "50mb" }));
    this.app.use(express.text({ type: "text/event-stream" }));
  }

  setupRoutes() {
    this.app.post("/v1/messages", async (req, res) => {
      const requestId = uuidv4();
      const timestamp = Date.now();

      try {
        const requestTrace = {
          id: requestId,
          timestamp,
          method: "POST",
          endpoint: "/v1/messages",
          headers: JSON.stringify(req.headers),
          body: JSON.stringify(req.body),
        };

        const insertRequest = this.db.prepare(`
          INSERT INTO requests (id, session_id, timestamp, method, endpoint, headers, body)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        insertRequest.run(
          requestId,
          this.currentSessionId,
          timestamp,
          requestTrace.method,
          requestTrace.endpoint,
          requestTrace.headers,
          requestTrace.body
        );
      } catch (dbError) {
        // eslint-disable-next-line no-console
        console.error("Database error storing request:", dbError);
        // Continue to process request even if DB storage fails
      }

      this.broadcast({
        type: "request",
        data: {
          id: requestId,
          timestamp,
          model: req.body?.model,
          messages: req.body?.messages,
          tools: req.body?.tools,
          temperature: req.body?.temperature,
          max_tokens: req.body?.max_tokens,
        },
      });

      try {
        if (req.body?.stream) {
          await this.handleStreamingRequest(req, res, requestId);
        } else {
          await this.handleRegularRequest(req, res, requestId);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Proxy error:", error);
        res.status(500).json({ error: "Proxy error", details: error.message });
      }
    });

    this.app.get("/api/sessions", (_req, res) => {
      const sessionsStatement = this.db.prepare(
        "SELECT * FROM sessions ORDER BY started_at DESC"
      );
      const sessions = sessionsStatement.all();
      res.json(sessions);
    });

    this.app.get("/api/traces/:sessionId?", (req, res) => {
      const query = req.params.sessionId
        ? "SELECT * FROM requests WHERE session_id = ? ORDER BY timestamp DESC"
        : "SELECT * FROM requests ORDER BY timestamp DESC LIMIT 100";

      const requestsStatement = this.db.prepare(query);
      const traces = req.params.sessionId
        ? requestsStatement.all(req.params.sessionId)
        : requestsStatement.all();

      const responsesStatement = this.db.prepare(
        "SELECT * FROM responses WHERE request_id = ?"
      );
      const toolCallsStatement = this.db.prepare(
        "SELECT * FROM tool_calls WHERE request_id = ?"
      );

      const fullTraces = traces.map((trace) => {
        const response = responsesStatement.get(trace.id);
        const toolCalls = toolCallsStatement.all(trace.id);
        return {
          ...trace,
          body: safeParseJSON(trace.body),
          response: response
            ? { ...response, body: safeParseJSON(response.body) }
            : null,
          toolCalls,
        };
      });

      res.json(fullTraces);
    });

    this.app.get("/api/stats", (_req, res) => {
      const requestCountStatement = this.db.prepare("SELECT COUNT(*) as count FROM requests");
      const tokenSumStatement = this.db.prepare(
        "SELECT SUM(tokens_used) as total FROM responses"
      );
      const latencyAvgStatement = this.db.prepare(
        "SELECT AVG(latency) as avg FROM responses"
      );
      const toolUsageStatement = this.db.prepare(`
          SELECT tool_name, COUNT(*) as count
          FROM tool_calls
          GROUP BY tool_name
          ORDER BY count DESC
        `);

      const stats = {
        totalRequests: requestCountStatement.get().count,
        totalTokens: tokenSumStatement.get().total || 0,
        avgLatency: latencyAvgStatement.get().avg || 0,
        toolUsage: toolUsageStatement.all(),
      };

      res.json(stats);
    });

    this.app.post("/api/clear", (_req, res) => {
      try {
        // Ensure foreign keys are enforced
        this.db.exec("PRAGMA foreign_keys = ON");

        // Clear all tracing data atomically
        this.db.exec("BEGIN");
        this.db.exec("DELETE FROM tool_calls");
        this.db.exec("DELETE FROM responses");
        this.db.exec("DELETE FROM requests");
        this.db.exec("DELETE FROM sessions");
        this.db.exec("COMMIT");

        // Recreate a fresh session for subsequent traces
        this.createSession();

        // Optionally compact the database file
        try {
          this.db.exec("VACUUM");
        } catch (_e) {
          // ignore VACUUM failures (not critical)
        }

        // Notify connected UIs to clear their in-memory traces
        this.broadcast({ type: "cleared" });

        res.json({ ok: true });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("Failed to clear traces:", e);
        try {
          this.db.exec("ROLLBACK");
        } catch {}
        res.status(500).json({ ok: false, error: "Failed to clear traces" });
      }
    });
  }

  buildAnthropicHeaders(requestHeaders) {
    return {
      "x-api-key": requestHeaders["x-api-key"] || process.env.ANTHROPIC_API_KEY,
      "anthropic-version": requestHeaders["anthropic-version"] || ANTHROPIC_DEFAULT_VERSION,
      "content-type": "application/json",
    };
  }

  extractAndStoreToolCalls(requestId, responseData) {
    if (!Array.isArray(responseData?.content)) {
      return;
    }

    for (const content of responseData.content) {
      if (content?.type === "tool_use") {
        const toolStatement = this.db.prepare(`
          INSERT INTO tool_calls (request_id, tool_name, input, timestamp)
          VALUES (?, ?, ?, ?)
        `);

        toolStatement.run(
          requestId,
          content.name,
          JSON.stringify(content.input ?? null),
          Date.now()
        );

        this.broadcast({
          type: "tool_call",
          data: {
            requestId,
            toolName: content.name,
            input: content.input,
          },
        });
      }
    }
  }

  parseStreamingResponse(fullResponse) {
    try {
      // Some providers stream JSON objects over SSE line by line; attempt to parse the last JSON object
      const lines = fullResponse
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const lastJsonLine = lines
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));

      return lastJsonLine ? JSON.parse(lastJsonLine) : null;
    } catch (_e) {
      return null;
    }
  }

  async handleRegularRequest(req, res, requestId) {
    const startTime = Date.now();

    const anthropicResponse = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: this.buildAnthropicHeaders(req.headers),
      body: JSON.stringify(req.body),
    });

    const responseData = await anthropicResponse.json();
    const latency = Date.now() - startTime;

    try {
      const insertResponse = this.db.prepare(`
        INSERT INTO responses (id, request_id, timestamp, status, headers, body, latency, tokens_used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertResponse.run(
        uuidv4(),
        requestId,
        Date.now(),
        anthropicResponse.status,
        JSON.stringify(
          Object.fromEntries(anthropicResponse.headers.entries?.() || [])
        ),
        JSON.stringify(responseData),
        latency,
        responseData?.usage?.output_tokens || 0
      );

      this.extractAndStoreToolCalls(requestId, responseData);
    } catch (dbError) {
      // eslint-disable-next-line no-console
      console.error("Database error storing response:", dbError);
      // Continue to send response even if DB storage fails
    }

    this.broadcast({
      type: "response",
      data: {
        requestId,
        response: responseData,
        latency,
        tokensUsed: responseData?.usage,
      },
    });

    res.status(anthropicResponse.status).json(responseData);
  }

  async handleStreamingRequest(req, res, requestId) {
    const startTime = Date.now();
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const anthropicResponse = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: this.buildAnthropicHeaders(req.headers),
      body: JSON.stringify(req.body),
    });

    let fullResponse = "";
    const reader = anthropicResponse.body;

    reader.on("data", (chunk) => {
      const chunkStr = chunk.toString();
      fullResponse += chunkStr;
      res.write(chunkStr);
      this.broadcast({
        type: "stream_chunk",
        data: { requestId, chunk: chunkStr },
      });
    });

    reader.on("end", () => {
      const latency = Date.now() - startTime;

      try {
        const insertResponse = this.db.prepare(`
          INSERT INTO responses (id, request_id, timestamp, status, body, latency)
          VALUES (?, ?, ?, ?, ?, ?)
        `);

        insertResponse.run(
          uuidv4(),
          requestId,
          Date.now(),
          200,
          fullResponse,
          latency
        );
      } catch (dbError) {
        // eslint-disable-next-line no-console
        console.error("Database error storing streaming response:", dbError);
        // Continue to complete the stream even if DB storage fails
      }

      // Try to extract the last JSON object from the SSE stream for structured response data
      const parsedFinal = this.parseStreamingResponse(fullResponse);

      this.broadcast({
        type: "response",
        data: {
          requestId,
          // Keep shape consistent with non-streaming where UI expects response + usage in tokensUsed
          response: parsedFinal || fullResponse,
          latency,
          tokensUsed: parsedFinal?.usage,
        },
      });
      res.end();
    });
  }

  setupWebSocket() {
    this.wss = new WebSocketServer({ port: this.wsPort });
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.send(
        JSON.stringify({
          type: "connected",
          data: { message: "Connected to Claude Code Tracer" },
        })
      );
    });
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    this.clients.forEach((client) => {
      if (client.readyState === WEBSOCKET_READY_STATE_OPEN) {
        client.send(data);
      }
    });
  }

  createSession() {
    this.currentSessionId = uuidv4();
    const insertSession = this.db.prepare(`
      INSERT INTO sessions (id, started_at)
      VALUES (?, ?)
    `);
    insertSession.run(this.currentSessionId, Date.now());
  }

  start() {
    this.createSession();

    this.server = this.app.listen(this.port, () => {
      // eslint-disable-next-line no-console
      console.log(
        `🚀 Claude Code Tracer proxy running on http://localhost:${this.port}`
      );
      // eslint-disable-next-line no-console
      console.log(`📊 WebSocket server running on ws://localhost:${this.wsPort}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.wss?.close();
      this.db?.close();
    }
  }
}

function safeParseJSON(maybeJSON) {
  try {
    return JSON.parse(maybeJSON);
  } catch (_e) {
    return null;
  }
}

export default ClaudeCodeTracer;
