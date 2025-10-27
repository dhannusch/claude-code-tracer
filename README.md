# Claude Code Tracer

Local proxy server that intercepts and visualizes all LLM interactions from Claude Code. Get real-time visibility into prompts, responses, tool calls, and token usage without modifying Claude Code itself.

## Features

- 🔍 **Real-time Request Tracing** - See every API call as it happens
- 📊 **Token Usage Analytics** - Track consumption and costs
- 🛠️ **Tool Call Visualization** - Monitor file edits, commands, and MCP usage
- 🌊 **Streaming Support** - Full SSE streaming with live updates
- 💾 **Local SQLite Storage** - All data stays on your machine
- 🚀 **Zero Configuration** - Works immediately with Claude Code

## Requirements

- **Node.js 22.5+** (uses built-in `node:sqlite`)
- Claude Code CLI installed

## Quick Start

```bash
# 1. Install dependencies
npm install
cd ui && npm install && cd ..

# 2. Start the tracer (proxy + UI)
npm run dev

# 3. Configure Claude Code (in a new terminal)
export ANTHROPIC_BASE_URL="http://localhost:3000"
export ANTHROPIC_API_KEY="sk-ant-your-key-here"

# 4. Run Claude Code - all requests will be traced!
claude
```

The UI will automatically open at `http://localhost:3001` showing:

- Live request stream via WebSocket
- Request/response details with syntax highlighting
- Token usage statistics
- Tool call timeline

## How It Works

Claude Code Tracer acts as a transparent HTTP proxy between Claude Code and Anthropic's API:

```
Claude Code → localhost:3000 (proxy) → Anthropic API
                    ↓
                SQLite DB → WebSocket → Browser UI (localhost:3001)
```

The proxy:

1. Intercepts `/v1/messages` requests
2. Logs request/response to SQLite
3. Broadcasts updates via WebSocket (port 3002)
4. Forwards to Anthropic and returns response

## CLI Commands

```bash
# Start proxy + UI
claude-code-tracer start

# Start without opening UI
claude-code-tracer start --no-ui

# Custom ports
claude-code-tracer start --port 4000 --ui-port 4001

# Stop the tracer
claude-code-tracer stop
```

## API Endpoints

The proxy exposes REST APIs for the UI:

- `GET /api/sessions` - List all tracing sessions
- `GET /api/traces/:sessionId?` - Get request traces (optionally filtered by session)
- `GET /api/stats` - Aggregated statistics (total requests, tokens, avg latency, tool usage)

## Testing Without Claude Code

You can test the proxy with curl:

```bash
# Start the tracer
npm run dev

# Send a test request
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": "Say hi"}]
  }'
```

The request will appear in the UI immediately, and stats will update upon completion.

## Architecture

```
claude-code-tracer/
├── proxy/
│   └── server.js         # Express proxy + SQLite database
├── ui/
│   ├── src/
│   │   ├── App.jsx       # React UI (WebSocket + REST)
│   │   └── main.jsx      # Entry point
│   ├── vite.config.js    # Vite configured for port 3001
│   └── package.json
├── cli/
│   └── index.js          # CLI entry point (starts proxy + UI)
└── package.json          # Root package (bin: claude-code-tracer)
```

## Database Schema

SQLite database (`traces.db`) with tables:

- `sessions` - Tracing sessions (id, started_at, ended_at, totals)
- `requests` - API requests (id, timestamp, method, endpoint, body)
- `responses` - API responses (id, request_id, status, body, latency, tokens_used)
- `tool_calls` - Tool invocations (id, request_id, tool_name, input, output)

## Privacy & Security

- **100% Local** - All data stays on your machine
- **No External Services** - Only forwards requests to Anthropic's API
- **API Key Safety** - Keys used only for forwarding, never stored
- **Open Source** - Fully auditable codebase

## Troubleshooting

### Port Already in Use

If ports 3000, 3001, or 3002 are busy:

```bash
claude-code-tracer start --port 4000 --ui-port 4001
```

WebSocket will use proxy port + 2 (e.g., 4002).

### UI Not Connecting

Check WebSocket connection in browser console. Ensure:

- Proxy is running on port 3000
- WebSocket server is on port 3002
- No firewall blocking localhost connections

### Native Module Errors (Node < 22.5)

Upgrade to Node 22.5+ to use built-in `node:sqlite`:

```bash
nvm install 22
nvm use 22
rm -rf node_modules package-lock.json
npm install
```

## Development

```bash
# Install dependencies
npm install
cd ui && npm install && cd ..

# Run proxy only
npm run proxy

# Run UI only
cd ui && npm run dev

# Run both (recommended)
npm run dev
```

## Roadmap

- [ ] Enhanced UI components (inspector, timeline, charts)
- [ ] Search and filter traces
- [ ] Export traces to JSON/CSV
- [ ] Multiple concurrent session support
- [ ] Cost estimation by model
- [ ] Prompt template analysis
- [ ] Support for other LLM providers

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.
