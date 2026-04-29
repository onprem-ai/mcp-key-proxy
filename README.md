# mcp-key-proxy

[![CI](https://github.com/onprem-ai/mcp-key-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/onprem-ai/mcp-key-proxy/actions/workflows/ci.yml)

Streamable HTTP proxy for stdio MCP servers with per-request API key injection via headers.

Pass API keys as HTTP headers — the proxy maps them to environment variables and manages a pool of child processes. Different keys get isolated processes. No race conditions. No restarts.

## Quick Start

The generic `mcp-key-proxy` Docker image wraps any stdio MCP server. Only two flags are required — everything else has sensible defaults:

**docker-compose.yml** (minimal)

```yaml
services:
  brave-mcp:
    image: ghcr.io/onprem-ai/mcp-key-proxy:latest
    command:
      - "--stdio"
      - "npx -y @brave/brave-search-mcp-server"
      - "--header-to-env"
      - "x-api-key=BRAVE_API_KEY"
    ports:
      - "8000:8000"
```

That's it. Clients send `x-api-key: <their-brave-key>` — the proxy injects it as `BRAVE_API_KEY` into an isolated child process.

**docker-compose.yml** (full options)

```yaml
services:
  brave-mcp:
    image: ghcr.io/onprem-ai/mcp-key-proxy:latest
    command:
      # The stdio MCP server to wrap — npx pulls it on first start
      - "--stdio"
      - "npx -y @brave/brave-search-mcp-server"
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

## Why This Exists

Most stdio MCP servers read credentials from environment variables (e.g. `BRAVE_API_KEY`, `GITHUB_TOKEN`). That works fine locally, but when you deploy them as shared HTTP services, you need each user to bring their own key — passed per-request via an HTTP header, not baked into the container.

We evaluated every existing MCP proxy and gateway. None of them support all four requirements at once:

| Project | Streamable HTTP | Header-to-env | Process pool + TTL | Multi-tenant safe |
|---------|:-:|:-:|:-:|:-:|
| [supergateway](https://github.com/supercorp-ai/supergateway) | Yes | No | No (single child) | No |
| [IBM mcp-context-forge](https://github.com/IBM/mcp-context-forge) | No (SSE only) | Yes | No (restarts single child) | No (race condition) |
| [mcp-streamablehttp-proxy](https://github.com/atrawog/mcp-streamablehttp-proxy) | Yes | No | 1:1 session:process | Partial (static env) |
| [mcp-front](https://github.com/stainless-api/mcp-front) (Stainless) | No (SSE only) | Yes (`$userToken`) | No pool/TTL | Yes |
| [mcp-proxy](https://github.com/punkpeye/mcp-proxy) | Yes | No | No | No |
| [mcp-auth](https://github.com/prmichaelsen/mcp-auth) | SSE/HTTP | Via token resolver | No | Yes (JWT) |
| **mcp-key-proxy** | **Yes** | **Yes** | **Yes** | **Yes** |

- **supergateway**: No header-to-env. One shared child process for everyone.
- **IBM mcp-context-forge**: Header-to-env exists but only on the SSE code path. Streamable HTTP ignores headers entirely. Also restarts the single child on every request — race condition when two users connect.
- **mcp-streamablehttp-proxy**: Per-session subprocess, but no way to inject headers as env vars. Every child gets the same static environment.
- **mcp-front**: Per-user isolation with token injection, but SSE-only transport and requires full OAuth/OIDC setup. Marked v0.0.1-DEV.
- **mcp-proxy / mcp-auth**: Either missing header-to-env, or require programmatic wrappers instead of a drop-in CLI.

mcp-key-proxy fills the gap: Streamable HTTP + header-to-env + keyed process pool + multi-tenant isolation. One command, no code changes to your MCP server.

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

Works with any stdio MCP server — just change `--stdio` and `--header-to-env`. Arguments for the wrapped server go right in the `--stdio` string:

```yaml
# GitHub MCP server — token per user
command:
  - "--stdio"
  - "npx -y @modelcontextprotocol/server-github"
  - "--header-to-env"
  - "x-github-token=GITHUB_TOKEN"

# Filesystem MCP with a path argument
command:
  - "--stdio"
  - "npx -y @modelcontextprotocol/server-filesystem /data"
  - "--header-to-env"
  - "x-api-key=API_KEY"
```

`--header-to-env` is optional. Without it, the proxy wraps a stdio server as Streamable HTTP with process pooling but no key injection:

```yaml
# Zefix (Swiss company registry) — no API key needed
command:
  - "--stdio"
  - "npx -y zefix-mcp-unofficial"
```

## Examples

### 1. Brave Search MCP

See [Quick Start](#quick-start) above.

### 2. Filesystem MCP Server

```yaml
services:
  filesystem-mcp:
    image: ghcr.io/onprem-ai/mcp-key-proxy:latest
    command:
      - "--stdio"
      - "npx -y @modelcontextprotocol/server-filesystem /data"
      - "--header-to-env"
      - "x-api-key=API_KEY"
      - "--port"
      - "8000"
      - "--host"
      - "0.0.0.0"
      - "--pool-size"
      - "3"
      - "--ttl"
      - "600"
      - "--cors"
      - "*"
    ports:
      - "8000:8000"
    volumes:
      - ./shared-data:/data
```

The filesystem MCP server gets access to `/data` inside the container. Mount any host directory to expose it. The `x-api-key` header acts as a simple access gate — the proxy rejects requests without it.

### 3. Multi-server stack

Run multiple MCP servers behind different ports, all using the same generic image:

```yaml
services:
  # Brave Search — API key per user
  brave-search:
    image: ghcr.io/onprem-ai/mcp-key-proxy:latest
    command:
      - "--stdio"
      - "npx -y @brave/brave-search-mcp-server"
      - "--header-to-env"
      - "x-api-key=BRAVE_API_KEY"
      - "--port"
      - "8000"
      - "--host"
      - "0.0.0.0"
      - "--pool-size"
      - "5"
      - "--ttl"
      - "300"
      - "--cors"
      - "*"
    ports:
      - "8001:8000"

  # GitHub MCP — token per user
  github:
    image: ghcr.io/onprem-ai/mcp-key-proxy:latest
    command:
      - "--stdio"
      - "npx -y @modelcontextprotocol/server-github"
      - "--header-to-env"
      - "x-github-token=GITHUB_PERSONAL_ACCESS_TOKEN"
      - "--port"
      - "8000"
      - "--host"
      - "0.0.0.0"
      - "--pool-size"
      - "3"
      - "--ttl"
      - "600"
      - "--cors"
      - "*"
    ports:
      - "8002:8000"

  # Filesystem — shared docs
  filesystem:
    image: ghcr.io/onprem-ai/mcp-key-proxy:latest
    command:
      - "--stdio"
      - "npx -y @modelcontextprotocol/server-filesystem /data"
      - "--header-to-env"
      - "x-api-key=ACCESS_KEY"
      - "--port"
      - "8000"
      - "--host"
      - "0.0.0.0"
      - "--pool-size"
      - "2"
      - "--ttl"
      - "300"
      - "--cors"
      - "*"
    ports:
      - "8003:8000"
    volumes:
      - ./docs:/data:ro
```

Same image, different MCP servers. Each service gets its own header-to-env mapping and pool configuration. Put nginx or Caddy in front for TLS and routing.

## How It Works

```
Client (POST /mcp)              mcp-key-proxy              stdio MCP server
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
| `--header-to-env <mapping>` | *(none)* | `Header-Name=ENV_VAR` mapping. Repeatable. Without it, all requests share one pool. |
| `--port <n>` | 8000 | HTTP listen port |
| `--host <s>` | 0.0.0.0 | Bind address |
| `--pool-size <n>` | 5 | Max processes per API key |
| `--ttl <n>` | 300 | Idle process TTL in seconds |
| `--queue-timeout <n>` | 30 | Max seconds to wait when pool is full |
| `--debug` | false | Verbose JSON logging to stderr |
| `--cors <origin>` | *(none)* | CORS allowed origin. Repeatable. |
| `--api-key <key>` | *(none)* | Require clients to send this static key via `Authorization: Bearer <key>`. Env: `API_KEY` |
| `--api-key-sha256 <hex>` | *(none)* | Same as above but accepts a SHA-256 hex digest instead of the clear-text key. Env: `API_KEY_SHA256` |

### Header mapping examples

```bash
# Brave Search: x-api-key header → BRAVE_API_KEY env var
--header-to-env "x-api-key=BRAVE_API_KEY"

# GitHub MCP: authorization header → GITHUB_TOKEN env var
--header-to-env "authorization=GITHUB_TOKEN"

# Multiple mappings (repeatable)
--header-to-env "x-api-key=API_KEY" --header-to-env "x-org-id=ORG_ID"
```

### Static API key

If you want a shared secret that all clients must provide (independent of `--header-to-env`), use `--api-key` or `--api-key-sha256`. Clients pass it via `Authorization: Bearer <key>`. Requests without a valid key get a 401.

```bash
# Clear text (dev/testing — visible in ps)
--api-key "sk-my-secret"

# SHA-256 hash (production — secret never in CLI args)
--api-key-sha256 "$(echo -n 'sk-my-secret' | sha256sum | cut -d' ' -f1)"

# Or via environment variables
API_KEY=sk-my-secret
API_KEY_SHA256=a1b2c3...
```

The two flags are mutually exclusive. This gate runs before header extraction — rejected requests never touch the process pool.

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

Run directly from GitHub — no npm registry needed:

```bash
# Latest version
npx github:onprem-ai/mcp-key-proxy \
  --stdio "npx -y @brave/brave-search-mcp-server" \
  --header-to-env "x-api-key=BRAVE_API_KEY"

# Pinned version
npx github:onprem-ai/mcp-key-proxy#v0.4.0 \
  --stdio "npx -y @brave/brave-search-mcp-server" \
  --header-to-env "x-api-key=BRAVE_API_KEY"
```

## Security

- **Process isolation** — each unique set of credentials gets its own pool of child processes. No credential mixing between tenants.
- **Clean environment** — child processes inherit only safe system variables (`PATH`, `HOME`, `TMPDIR`, `USER`, `LANG`). No leaking of host env vars.
- **Header injection prevention** — header values containing newlines, carriage returns, or null bytes are rejected (400).
- **Timing-safe key comparison** — static API key checks use constant-time comparison via `crypto.timingSafeEqual`. Both plain-text and hashed modes normalize to SHA-256 before comparing, preventing length-based timing leaks.
- **No credential logging** — API keys and header values are never written to logs. Auth failures log the event, not the submitted value.
- **Opaque error responses** — authentication failures return a generic 401 without revealing whether the key was missing, malformed, or wrong.

**Production recommendations:**

- Use `--api-key-sha256` (or `API_KEY_SHA256` env var) instead of `--api-key` to avoid exposing the secret in process listings.
- Put a reverse proxy (nginx, Caddy) in front for TLS termination and rate limiting.
- Report vulnerabilities to **security@digilac.ch** (see [SECURITY.md](SECURITY.md)).

## Development

```bash
npm install
npm run build
npm test          # 59 tests
npm run dev       # Run with tsx (no build needed)
```

## License

MIT
