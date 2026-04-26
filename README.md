# mcp-apikey-proxy

Streamable HTTP proxy for stdio MCP servers with per-request API key injection via headers.

Pass API keys as HTTP headers — the proxy maps them to environment variables and manages a pool of child processes. Different keys get isolated processes. No race conditions. No restarts.

## Quick Start: Brave Search MCP

**docker-compose.yml**

```yaml
services:
  brave-mcp:
    build: .
    # Or use a pre-built image:
    # image: ghcr.io/your-org/mcp-apikey-proxy:latest
    command:
      # The stdio MCP server to wrap
      - "--stdio"
      - "brave-search-mcp-server"
      # Map HTTP header → env var for the child process
      # Clients send: x-api-key: <their-brave-key>
      # Child receives: BRAVE_API_KEY=<their-brave-key>
      - "--header-to-env"
      - "x-api-key=BRAVE_API_KEY"
      # Server config
      - "--port"
      - "8000"
      - "--host"
      - "0.0.0.0"
      # Pool: up to 5 processes per unique API key, idle for 5min
      - "--pool-size"
      - "5"
      - "--ttl"
      - "300"
      # Allow all CORS origins (restrict in production)
      - "--cors"
      - "*"
    ports:
      - "8000:8000"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8000/health').then(r=>{if(!r.ok)throw 1})"]
      interval: 10s
      timeout: 5s
      retries: 3
```

```bash
docker compose up -d
```

**Test it:**

```bash
# Initialize
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_BRAVE_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "test", "version": "1.0" }
    }
  }'

# Search (use the Mcp-Session-Id from the response above)
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_BRAVE_API_KEY" \
  -H "Mcp-Session-Id: SESSION_ID_FROM_ABOVE" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "brave_web_search",
      "arguments": { "query": "hello world", "count": 3 }
    }
  }'
```

## How It Works

```
Client (POST /mcp)              mcp-apikey-proxy              stdio MCP server
  │                                │                              │
  │  x-api-key: key-A             │                              │
  │ ──────────────────────────────►│                              │
  │                                ├─ extract header              │
  │                                ├─ pool key = sha256("key-A") │
  │                                ├─ pool lookup:                │
  │                                │   idle worker? → reuse       │
  │                                │   none idle?   → spawn new   │
  │                                │   pool full?   → queue/503   │
  │                                │                              │
  │                                ├─ spawn(BRAVE_API_KEY=key-A)─►│
  │                                │         stdin/stdout          │
  │ ◄──────────────────────────────┤◄─────────────────────────────│
  │       JSON-RPC response        │  release worker (now idle)   │
```

- **Same key** → reuses an idle process (0ms acquire)
- **Different key** → gets its own pool of processes (full isolation)
- **Pool full** → queues up to `--queue-timeout` seconds, then 503
- **Idle processes** → evicted after `--ttl` seconds

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--stdio <cmd>` | *(required)* | Command to spawn the stdio MCP server |
| `--header-to-env <mapping>` | *(required)* | `Header-Name=ENV_VAR` mapping. Repeatable. |
| `--port <n>` | 8000 | HTTP listen port |
| `--host <s>` | 0.0.0.0 | Bind address |
| `--pool-size <n>` | 5 | Max processes per API key |
| `--ttl <n>` | 300 | Idle process TTL in seconds |
| `--queue-timeout <n>` | 30 | Max seconds to wait when pool is full |
| `--debug` | false | Verbose JSON logging to stderr |
| `--cors <origin>` | *(none)* | CORS allowed origin. Repeatable. |

### Header mapping examples

```bash
# Brave Search: x-api-key header → BRAVE_API_KEY env var
--header-to-env "x-api-key=BRAVE_API_KEY"

# GitHub MCP: authorization header → GITHUB_TOKEN env var
--header-to-env "authorization=GITHUB_TOKEN"

# Multiple mappings (repeatable)
--header-to-env "x-api-key=API_KEY" --header-to-env "x-org-id=ORG_ID"
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mcp` | MCP JSON-RPC endpoint (Streamable HTTP) |
| DELETE | `/mcp` | Close a session (requires `Mcp-Session-Id` header) |
| GET | `/health` | Pool stats, total workers, uptime |

## Health Check

```bash
curl http://localhost:8000/health
```

```json
{
  "status": "ok",
  "pools": {
    "10e43b5ee86d88da": {
      "size": 1,
      "available": 1,
      "borrowed": 0,
      "pending": 0
    }
  },
  "totalWorkers": 1,
  "uptime": 42
}
```

## Without Docker

```bash
# Install
npm install -g mcp-apikey-proxy

# Or run directly
npx mcp-apikey-proxy \
  --stdio "brave-search-mcp-server" \
  --header-to-env "x-api-key=BRAVE_API_KEY" \
  --port 8000
```

## Development

```bash
npm install
npm run build
npm test          # 39 tests
npm run dev       # Run with tsx (no build needed)
```

## License

MIT
