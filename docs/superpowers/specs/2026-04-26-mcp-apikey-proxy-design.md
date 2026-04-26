# mcp-apikey-proxy Design Spec

**Date**: 2026-04-26
**Status**: Approved

## Problem

No existing MCP proxy supports all of:
1. Streamable HTTP transport
2. Per-request header-to-env injection (API key via HTTP header → child process env var)
3. Multi-tenant process pool with idle eviction (no race conditions)
4. Per-key isolation with configurable pool size

## Solution

A TypeScript CLI tool that bridges HTTP clients to stdio MCP servers. Incoming HTTP headers are mapped to environment variables. A keyed process pool manages child processes — same API key reuses idle processes, different keys get isolated pools.

## CLI Interface

Single command, no subcommands, no config files.

```bash
npx mcp-apikey-proxy \
  --stdio "brave-search-mcp-server" \
  --header-to-env "X-Brave-Api-Key=BRAVE_API_KEY" \
  --port 8000 \
  --host 0.0.0.0 \
  --pool-size 5 \
  --ttl 300 \
  --queue-timeout 30 \
  --debug \
  --cors "*"
```

### Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--stdio <cmd>` | Yes | — | Shell command to spawn the stdio MCP server |
| `--header-to-env <mapping>` | Yes | — | `Header-Name=ENV_VAR` mapping. Repeatable. |
| `--port <n>` | No | 8000 | HTTP listen port |
| `--host <s>` | No | 0.0.0.0 | Bind address |
| `--pool-size <n>` | No | 5 | Max processes per API key |
| `--ttl <n>` | No | 300 | Idle process TTL in seconds |
| `--queue-timeout <n>` | No | 30 | Max seconds to wait for a process when pool is full |
| `--debug` | No | false | Verbose structured JSON logging |
| `--cors <origin>` | No | — | CORS allowed origin. Repeatable. |

## Architecture

```
HTTP Client (POST /mcp, GET /mcp, DELETE /mcp)
  │
  ├─ Express middleware: extract mapped headers → env vars
  ├─ Compute pool key = sha256(sorted env pairs)
  │
  ├─ PoolManager.acquire(key, envVars)
  │   ├─ Pool exists for key?
  │   │   ├─ Yes → genericPool.acquire() → idle worker or spawn new
  │   │   └─ No  → create new pool for this key, then acquire
  │   └─ Acquire timeout exceeded → 503 Service Unavailable
  │
  ├─ Worker: forward JSON-RPC via child's stdin/stdout
  │   ├─ Write request to child stdin
  │   ├─ Read response from child stdout
  │   └─ Return response to HTTP client
  │
  ├─ PoolManager.release(key, worker) → worker becomes idle
  │
  └─ Background: generic-pool TTL evictor destroys idle workers
```

## Components

### `src/cli.ts` — Entry point + arg parsing

Parses CLI flags, validates required args, constructs config object, calls `createServer()`. Uses `commander` for arg parsing.

### `src/server.ts` — Express HTTP server

- `POST /mcp` — Main MCP endpoint. Extracts headers, acquires worker, proxies JSON-RPC request/response via the worker, releases worker.
- `GET /mcp` — SSE endpoint for server-to-client notifications (MCP spec requirement).
- `DELETE /mcp` — Session termination (MCP spec requirement).
- `GET /health` — Returns `{ status, pools: { [key]: { total, idle, pending } }, totalWorkers, uptime }`.
- CORS middleware (optional, based on `--cors` flag).

The server does NOT use MCP SDK's `StreamableHTTPServerTransport` directly — that transport binds 1:1 to a single MCP Server instance. Instead, we implement the Streamable HTTP protocol at the HTTP layer: parse JSON-RPC from the request body, forward to the worker's stdin, collect response from stdout, return as JSON or SSE depending on the request.

### `src/pool-manager.ts` — Keyed process pool

- Maintains a `Map<poolKey, genericPool.Pool<Worker>>`.
- `acquire(key, env)`: finds or creates pool for key, calls `pool.acquire()` with timeout.
- `release(key, worker)`: returns worker to pool (idle).
- `destroyAll()`: shuts down all pools on server close.
- Pool factory: `create()` spawns child process with env, `destroy()` kills it.
- Config: `max` = `--pool-size`, `idleTimeoutMillis` = `--ttl * 1000`, `acquireTimeoutMillis` = `--queue-timeout * 1000`.
- Stale pool cleanup: pools with 0 workers and 0 pending requests are removed from the map periodically.

### `src/worker.ts` — Child process wrapper

- Spawns child via `child_process.spawn()` with the given command + env vars.
- Communicates via stdin/stdout using newline-delimited JSON (JSON-RPC).
- `send(jsonrpc)`: writes to stdin, returns promise that resolves with the response from stdout.
- `destroy()`: kills child process (SIGTERM, then SIGKILL after 5s).
- `isAlive()`: checks if child process is still running.
- Read buffer handles partial JSON lines from stdout.

### `src/header-extractor.ts` — Header→env mapping

- Parses `--header-to-env` strings into `Array<{ headerName: string, envVar: string }>`.
- `extract(req, mappings)`: reads mapped headers from the request, returns `Record<string, string>`.
- Validates header values (no newlines, no null bytes — prevents header injection).
- Computes pool key: `sha256(JSON.stringify(sorted entries))`.
- If a required header is missing from the request → 401 Unauthorized.

### `src/logger.ts` — Structured JSON logger

- Writes to stderr (stdout is reserved for potential stdio passthrough).
- Every log line is a JSON object: `{ ts, level, msg, ...extra }`.
- Levels: `error`, `warn`, `info`, `debug`.
- `--debug` flag enables `debug` level.
- Request logs include: `{ method, poolKey (truncated), acquireMs, status, durationMs }`.

### `src/types.ts` — Shared types

Config interface, worker state enum, pool stats type.

## Protocol Handling

The proxy implements MCP's Streamable HTTP transport:

1. **POST /mcp** — Client sends JSON-RPC request(s). Proxy forwards to worker stdin, collects response(s) from stdout, returns as `application/json` (single response) or `text/event-stream` (streaming/notifications).

2. **GET /mcp** — Opens SSE stream for server-initiated notifications. For v1, we return 405 (stdio servers don't push unsolicited notifications in practice).

3. **DELETE /mcp** — Session cleanup. Releases the worker back to pool. Returns 200.

4. **Mcp-Session-Id** — Generated on first `initialize` request. Maps to pool key so subsequent requests from the same session reuse the same pool. Stored in-memory `Map<sessionId, poolKey>`.

### JSON-RPC forwarding

The worker reads/writes newline-delimited JSON-RPC over stdio. For each HTTP request:

1. Parse JSON body (single request or batch).
2. Acquire worker from pool.
3. For each JSON-RPC message: write to worker stdin.
4. Collect responses: read from worker stdout until we have responses for all request IDs (with timeout).
5. Release worker to pool.
6. Return responses to HTTP client.

Notifications (no `id` field) are fire-and-forget — forwarded to worker but no response expected.

## Error Handling

| Scenario | HTTP Response |
|----------|--------------|
| Missing required header | 401 `{ error: "Missing required header: X-Brave-Api-Key" }` |
| Invalid header value | 400 `{ error: "Invalid header value" }` |
| Pool acquire timeout | 503 `{ error: "Service unavailable: all workers busy" }` |
| Worker process died | 502 `{ error: "Worker process exited unexpectedly" }` |
| Worker response timeout | 504 `{ error: "Worker response timeout" }` |
| Invalid JSON body | 400 `{ error: "Invalid JSON" }` |
| Invalid session ID | 404 `{ error: "Session not found" }` |

## Testing Strategy

All tests use `vitest`. No live MCP servers — workers spawn a simple echo server script.

### Unit tests

- **header-extractor**: Parsing mappings, extracting headers, missing headers, injection prevention, pool key computation.
- **pool-manager**: Pool creation, acquire/release, TTL eviction, max size, queue timeout, destroy all.
- **worker**: Spawn, send/receive JSON-RPC, destroy, handle crash.
- **logger**: JSON output, level filtering, debug mode.
- **cli**: Flag parsing, validation, defaults.

### Integration tests

- **Full request flow**: POST /mcp with header → worker spawned → response returned.
- **Multi-tenant isolation**: Two different API keys → two different workers, no cross-contamination.
- **Pool reuse**: Same API key, sequential requests → same worker reused.
- **Pool exhaustion**: Fill pool, verify queueing and 503 on timeout.
- **Session management**: Initialize → get session ID → subsequent requests use same pool.
- **Health endpoint**: Returns correct pool stats.
- **CORS**: Headers present when configured.

### Test fixtures

A minimal echo MCP server script (`tests/fixtures/echo-server.ts`) that:
- Responds to `initialize` with server info.
- Responds to `tools/list` with a dummy tool.
- Responds to `tools/call` by echoing arguments + `BRAVE_API_KEY` env var value.
- Reads API key from env var to prove header→env injection works.

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server + routing |
| `cors` | CORS middleware |
| `generic-pool` | Process pool with idle eviction |
| `commander` | CLI arg parsing |
| `uuid` | Session ID generation |
| `typescript` | Build |
| `vitest` | Test runner |
| `@types/express` | Types |
| `@types/cors` | Types |
| `tsx` | Dev runner |

Note: We do NOT depend on `@modelcontextprotocol/sdk`. The proxy speaks raw JSON-RPC over stdio (simple newline-delimited JSON) and implements the HTTP transport protocol directly. This avoids coupling to SDK internals and keeps the proxy generic.

## File Structure

```
mcp-apikey-proxy/
├── src/
│   ├── cli.ts
│   ├── server.ts
│   ├── pool-manager.ts
│   ├── worker.ts
│   ├── header-extractor.ts
│   ├── logger.ts
│   └── types.ts
├── tests/
│   ├── fixtures/
│   │   └── echo-server.ts
│   ├── unit/
│   │   ├── header-extractor.test.ts
│   │   ├── pool-manager.test.ts
│   │   ├── worker.test.ts
│   │   ├── logger.test.ts
│   │   └── cli.test.ts
│   └── integration/
│       └── server.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Non-Goals (v1)

- OAuth / OIDC authentication (use a reverse proxy like nginx for that).
- TLS termination (use nginx/caddy in front).
- Config file support (flags only).
- Docker image publishing (users build their own or use npx).
- Prometheus metrics endpoint (structured JSON logs are sufficient for v1).
- GET /mcp SSE streaming for server-initiated notifications.
