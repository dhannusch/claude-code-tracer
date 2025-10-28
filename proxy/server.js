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
    this.setupStatements();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  setupStatements() {
    // Frequently used prepared statements to reduce per-request overhead
    this.stmts = {
      insertRequest: this.db.prepare(`
        INSERT INTO requests (id, session_id, timestamp, method, endpoint, headers, body, stream)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertResponseFull: this.db.prepare(`
        INSERT INTO responses (id, request_id, timestamp, status, headers, body, latency, tokens_used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertResponseStream: this.db.prepare(`
        INSERT INTO responses (id, request_id, timestamp, status, body, latency, tokens_used)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      insertToolCall: this.db.prepare(`
        INSERT INTO tool_calls (request_id, tool_name, input, timestamp)
        VALUES (?, ?, ?, ?)
      `),
      selectResponsesByRequest: this.db.prepare(
        "SELECT * FROM responses WHERE request_id = ?"
      ),
      selectToolCallsByRequest: this.db.prepare(
        "SELECT * FROM tool_calls WHERE request_id = ?"
      ),
      selectSessions: this.db.prepare(
        "SELECT * FROM sessions ORDER BY started_at DESC"
      ),
      selectRequestsBySession: this.db.prepare(
        "SELECT * FROM requests WHERE session_id = ? ORDER BY timestamp DESC"
      ),
      selectRecentRequests: this.db.prepare(
        "SELECT * FROM requests ORDER BY timestamp DESC LIMIT 100"
      ),
      insertSession: this.db.prepare(`
        INSERT INTO sessions (id, started_at)
        VALUES (?, ?)
      `),
    };
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
        stream INTEGER DEFAULT 0,
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
          headers: null,
          body: JSON.stringify(req.body),
        };

        this.stmts.insertRequest.run(
          requestId,
          this.currentSessionId,
          timestamp,
          requestTrace.method,
          requestTrace.endpoint,
          requestTrace.headers,
          requestTrace.body,
          req.body?.stream ? 1 : 0
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
          stream: req.body?.stream,
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
      const sessions = this.stmts.selectSessions.all();
      res.json(sessions);
    });

    this.app.get("/api/traces/:sessionId?", (req, res) => {
      const traces = req.params.sessionId
        ? this.stmts.selectRequestsBySession.all(req.params.sessionId)
        : this.stmts.selectRecentRequests.all();

      const fullTraces = traces.map((trace) => {
        const response = this.stmts.selectResponsesByRequest.get(trace.id);
        const toolCalls = this.stmts.selectToolCallsByRequest.all(trace.id);
        const parsedBody = safeParseJSON(trace.body);
        return {
          ...trace,
          body: parsedBody,
          stream: trace.stream === 1 || parsedBody?.stream === true,
          response: response
            ? { ...response, body: safeParseJSON(response.body) }
            : null,
          toolCalls,
        };
      });

      res.json(fullTraces);
    });

    this.app.get("/api/stats", (_req, res) => {
      const requestCountStatement = this.db.prepare(
        "SELECT COUNT(*) as count FROM requests"
      );
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
      "anthropic-version":
        requestHeaders["anthropic-version"] || ANTHROPIC_DEFAULT_VERSION,
      "content-type": "application/json",
    };
  }

  extractAndStoreToolCalls(requestId, responseData) {
    if (!Array.isArray(responseData?.content)) {
      return;
    }

    for (const content of responseData.content) {
      if (content?.type === "tool_use") {
        this.stmts.insertToolCall.run(
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

  // Calculate total tokens from a usage object
  calculateTokens(usage) {
    if (!usage || typeof usage !== "object") return 0;
    const total = usage.total_tokens;
    if (typeof total === "number" && isFinite(total)) return total;
    const input =
      typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const output =
      typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    return input + output;
  }

  // Extract token usage from Anthropic SSE by scanning for usage in message_delta (preferred) or message_start
  extractUsageFromSSE(sse) {
    try {
      const records = sse.split("\n\n");
      let usage = null;
      for (const rec of records) {
        if (!rec) continue;
        const lines = rec.split("\n");
        let evt = null;
        const dataParts = [];
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          if (t.startsWith("event:")) evt = t.slice(6).trim();
          else if (t.startsWith("data:")) dataParts.push(t.slice(5).trim());
        }
        if (evt !== "message_delta" && evt !== "message_start") continue;
        const rawData = dataParts.join("\n");
        try {
          const parsed = JSON.parse(rawData);
          if (evt === "message_delta") {
            if (parsed && typeof parsed === "object" && parsed.usage) {
              usage = parsed.usage;
            }
          } else if (evt === "message_start") {
            if (
              parsed &&
              typeof parsed === "object" &&
              parsed.message &&
              typeof parsed.message === "object" &&
              parsed.message.usage
            ) {
              usage = parsed.message.usage;
            }
          }
        } catch (_e) {
          // ignore parse errors and continue
        }
      }
      return usage;
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
      this.stmts.insertResponseFull.run(
        uuidv4(),
        requestId,
        Date.now(),
        anthropicResponse.status,
        null,
        JSON.stringify(responseData),
        latency,
        this.calculateTokens(responseData?.usage)
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
        tokensUsedTotal: this.calculateTokens(responseData?.usage),
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
    });

    reader.on("end", () => {
      const latency = Date.now() - startTime;

      try {
        // Try to extract usage tokens from the SSE stream once
        const sseUsage = this.extractUsageFromSSE(fullResponse);
        // Try to extract the last JSON object from the SSE stream for structured response data
        const parsedFinal = this.parseStreamingResponse(fullResponse);
        // Fallback usage from SSE if final parsed object does not include usage
        const usage = parsedFinal?.usage || sseUsage;
        const tokensTotal = this.calculateTokens(usage);

        this.stmts.insertResponseStream.run(
          uuidv4(),
          requestId,
          Date.now(),
          200,
          fullResponse,
          latency,
          tokensTotal
        );

        this.broadcast({
          type: "response",
          data: {
            requestId,
            // Keep shape consistent with non-streaming where UI expects response + usage in tokensUsed
            response: parsedFinal || fullResponse,
            latency,
            tokensUsedTotal: tokensTotal,
          },
        });
      } catch (dbError) {
        // eslint-disable-next-line no-console
        console.error("Database error storing streaming response:", dbError);
        // Continue to complete the stream even if DB storage fails
        const parsedFinal = this.parseStreamingResponse(fullResponse);
        const usage = this.extractUsageFromSSE(fullResponse);
        this.broadcast({
          type: "response",
          data: {
            requestId,
            response: parsedFinal || fullResponse,
            latency,
            tokensUsedTotal: this.calculateTokens(usage),
          },
        });
      }
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
    this.stmts.insertSession.run(this.currentSessionId, Date.now());
  }

  start() {
    this.createSession();

    this.server = this.app.listen(this.port, () => {
      // eslint-disable-next-line no-console
      console.log(
        `🚀 Claude Code Tracer proxy running on http://localhost:${this.port}`
      );
      // eslint-disable-next-line no-console
      console.log(
        `📊 WebSocket server running on ws://localhost:${this.wsPort}`
      );
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
  if (!maybeJSON) return null;
  if (typeof maybeJSON !== "string") return maybeJSON;
  // If it looks like SSE format, return as-is (for streaming responses)
  if (maybeJSON.trim().startsWith("event:")) return maybeJSON;
  try {
    return JSON.parse(maybeJSON);
  } catch (_e) {
    // If parsing fails, return the raw string (e.g., for SSE or other formats)
    return maybeJSON;
  }
}

export default ClaudeCodeTracer;
