# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Tracer is a local proxy server that intercepts and visualizes all LLM interactions from Claude Code. It acts as a transparent HTTP proxy between Claude Code and Anthropic's API, logging all requests/responses to a local SQLite database and broadcasting updates to a web UI via WebSocket.

## Key Architecture

The project consists of three main components:

1. **Proxy Server** (`proxy/server.js`): Express server that intercepts `/v1/messages` requests, logs to SQLite, forwards to Anthropic API, and broadcasts to WebSocket clients
2. **Web UI** (`ui/`): React + Vite application that displays real-time traces via WebSocket
3. **CLI** (`cli/index.js`): Commander-based CLI that orchestrates starting the proxy and UI

**Data Flow:**
```
Claude Code → localhost:3000 (proxy) → Anthropic API
                    ↓
                SQLite DB → WebSocket (port 3002) → Browser UI (localhost:3001)
```

## Development Commands

### Installation
```bash
# Install root dependencies
npm install

# Install UI dependencies
cd ui && npm install && cd ..
```

### Running the Project
```bash
# Start both proxy and UI (recommended for development)
npm run dev

# Start proxy only
npm run proxy

# Start UI only (requires proxy to be running separately)
cd ui && npm run dev

# Using the CLI directly
node cli/index.js start
```

### Testing the Proxy
```bash
# Start the tracer
npm run dev

# In another terminal, test with curl
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model": "claude-3-5-sonnet-20241022", "max_tokens": 64, "messages": [{"role": "user", "content": "Say hi"}]}'
```

## Database Schema

The SQLite database (`traces.db`) uses Node.js 22.5+ built-in `node:sqlite` module (via `DatabaseSync`). Tables:

- **sessions**: Tracing sessions (id, started_at, ended_at, totals)
- **requests**: API requests (id, session_id, timestamp, method, endpoint, headers, body)
- **responses**: API responses (id, request_id, timestamp, status, headers, body, latency, tokens_used)
- **tool_calls**: Tool invocations extracted from responses (id, request_id, tool_name, input, output, timestamp)

Indices exist on `requests(session_id)`, `requests(timestamp)`, and `responses(request_id)`.

## Important Technical Details

### Node.js Version Requirement
This project requires **Node.js 22.5+** because it uses the built-in `node:sqlite` module (`DatabaseSync` class). Earlier versions will fail with module errors.

### Port Configuration
- Proxy: Default 3000 (configurable via `--port`)
- UI: Default 3001 (configurable via `--ui-port`)
- WebSocket: Hardcoded 3002 (always proxy port + 2)

### Streaming Support
The proxy fully supports SSE (Server-Sent Events) streaming:
- Detects `stream: true` in request body
- Sets appropriate SSE headers
- Forwards chunks in real-time to both Claude Code and WebSocket clients
- Stores complete response after streaming completes

### Tool Call Extraction
The proxy automatically detects and logs tool calls from Anthropic responses by scanning `content` array for `type: "tool_use"` blocks. Tool calls are:
- Stored in the `tool_calls` table
- Broadcast via WebSocket with type `"tool_call"`
- Linked to their parent request via `request_id`

### WebSocket Message Types
The UI receives these WebSocket message types:
- `"connected"`: Initial connection confirmation
- `"request"`: New request received (includes id, timestamp, model, messages, tools, etc.)
- `"response"`: Request completed (includes requestId, response data, latency, tokensUsed)
- `"tool_call"`: Tool invocation detected (includes requestId, toolName, input)
- `"stream_chunk"`: Streaming response chunk (includes requestId, chunk)

## API Endpoints

The proxy exposes REST APIs on the proxy port (default 3000):

- `POST /v1/messages`: Main proxy endpoint (forwards to Anthropic)
- `GET /api/sessions`: List all tracing sessions
- `GET /api/traces/:sessionId?`: Get request traces (optionally filtered by session)
- `GET /api/stats`: Aggregated statistics (totalRequests, totalTokens, avgLatency, toolUsage)

## Session Management

Each time the proxy starts, it creates a new session in the database via `uuidv4()`. The session ID is stored in `this.currentSessionId` and used for all subsequent requests until the proxy is stopped. Sessions allow grouping related Claude Code interactions.

## Configuration with Claude Code

To use the tracer with Claude Code:

```bash
# Start the tracer
npm run dev

# In another terminal, configure Claude Code
export ANTHROPIC_BASE_URL="http://localhost:3000"
export ANTHROPIC_API_KEY="sk-ant-your-actual-key"

# Run Claude Code normally - all requests will be traced
claude
```

The tracer is transparent - Claude Code has no awareness it's being proxied.

## Common Gotchas

1. **Port conflicts**: If ports 3000-3002 are in use, the proxy will fail to start. Use `--port` and `--ui-port` to configure alternatives.

2. **Database locking**: SQLite uses `node:sqlite` in synchronous mode. The database file (`traces.db`) is opened once at startup. Multiple proxy instances will conflict.

3. **JSON parsing safety**: The codebase includes a `safeParseJSON` helper (proxy/server.js:388) because some database fields store JSON strings that may be malformed.

4. **API key handling**: The proxy forwards the `x-api-key` header from requests, falling back to `process.env.ANTHROPIC_API_KEY`. Keys are never stored in the database.

5. **UI WebSocket hardcoding**: The UI currently hardcodes WebSocket connection to `ws://localhost:3002`. If you change the proxy port, update this accordingly.
