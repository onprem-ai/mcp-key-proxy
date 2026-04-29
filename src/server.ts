import express from "express";
import corsMiddleware from "cors";
import { v4 as uuid } from "uuid";
import { PoolManager } from "./pool-manager.js";
import {
  extractHeaders,
  MissingHeaderError,
  InvalidHeaderError,
} from "./header-extractor.js";
import { checkApiKey } from "./api-key-auth.js";
import { log } from "./logger.js";
import type { Config, HealthResponse, JsonRpcRequest } from "./types.js";

export function createApp(config: Config) {
  const app = express();
  const poolManager = new PoolManager(config);
  const startTime = Date.now();

  // Session → poolKey mapping
  const sessions = new Map<string, string>();

  // Parse JSON bodies
  app.use(express.json({ limit: "1mb" }));

  // CORS
  if (config.corsOrigins.length > 0) {
    app.use(
      corsMiddleware({
        origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", ...config.headerMappings.map((m) => m.headerName)],
        exposedHeaders: ["Mcp-Session-Id"],
      }),
    );
  }

  // Health endpoint
  app.get("/health", (_req, res) => {
    const stats = poolManager.getStats();
    const body: HealthResponse = {
      status: "ok",
      pools: stats,
      totalWorkers: poolManager.getTotalWorkers(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };
    res.json(body);
  });

  // MCP Streamable HTTP endpoint
  app.post("/mcp", async (req, res) => {
    if (!checkApiKey(req.headers.authorization, config)) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }

    const reqStart = Date.now();
    let poolKey: string | undefined;

    try {
      // Extract env vars from headers
      const extracted = extractHeaders(req.headers, config.headerMappings);
      poolKey = extracted.poolKey;

      // Parse body
      const body = req.body as JsonRpcRequest | JsonRpcRequest[];
      const requests = Array.isArray(body) ? body : [body];

      if (requests.length === 0) {
        res.status(400).json({ error: "Empty request" });
        return;
      }

      // Validate JSON-RPC
      for (const r of requests) {
        if (r.jsonrpc !== "2.0" || !r.method) {
          res.status(400).json({ error: "Invalid JSON-RPC request" });
          return;
        }
      }

      // Check for existing session
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const existingKey = sessions.get(sessionId)!;
        if (existingKey !== poolKey) {
          res.status(400).json({ error: "Session key mismatch" });
          return;
        }
      }

      // Acquire worker
      const acquireStart = Date.now();
      const worker = await poolManager.acquire(poolKey, extracted.envVars);
      const acquireMs = Date.now() - acquireStart;

      try {
        const responses = [];
        let newSessionId: string | undefined;

        for (const request of requests) {
          if (request.id === undefined || request.id === null) {
            // Notification — fire and forget
            await worker.sendNotification(request);
            continue;
          }

          const resp = await worker.send(request);
          responses.push(resp);

          // If this is an initialize response, create a session
          if (request.method === "initialize" && !sessionId) {
            newSessionId = uuid();
            sessions.set(newSessionId, poolKey);
          }
        }

        // Release worker back to pool
        poolManager.release(poolKey, worker);

        const durationMs = Date.now() - reqStart;
        log.info("request", {
          method: requests[0]?.method,
          poolKey,
          acquireMs,
          status: 200,
          durationMs,
        });

        // Set session header
        if (newSessionId) {
          res.setHeader("Mcp-Session-Id", newSessionId);
        } else if (sessionId) {
          res.setHeader("Mcp-Session-Id", sessionId);
        }

        // Return response(s)
        if (responses.length === 0) {
          res.status(202).send();
        } else if (responses.length === 1) {
          res.json(responses[0]);
        } else {
          res.json(responses);
        }
      } catch (err) {
        poolManager.release(poolKey, worker);
        throw err;
      }
    } catch (err) {
      const durationMs = Date.now() - reqStart;

      if (err instanceof MissingHeaderError) {
        log.warn("missing header", { header: err.headerName, durationMs });
        res.status(401).json({ error: err.message });
        return;
      }
      if (err instanceof InvalidHeaderError) {
        log.warn("invalid header", { header: err.headerName, durationMs });
        res.status(400).json({ error: err.message });
        return;
      }

      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("timeout")) {
        log.error("timeout", { poolKey, durationMs, error: message });
        if (message.includes("response timeout")) {
          res.status(504).json({ error: "Worker response timeout" });
        } else {
          res.status(503).json({ error: "Service unavailable: all workers busy" });
        }
        return;
      }

      if (message.includes("exited") || message.includes("not running")) {
        log.error("worker error", { poolKey, durationMs, error: message });
        res.status(502).json({ error: "Worker process exited unexpectedly" });
        return;
      }

      log.error("request error", { poolKey, durationMs, error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /mcp — SSE for server-initiated notifications (not supported in v1)
  app.get("/mcp", (req, res) => {
    if (!checkApiKey(req.headers.authorization, config)) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    res.status(405).json({ error: "GET /mcp not supported in v1" });
  });

  // DELETE /mcp — session cleanup
  app.delete("/mcp", (req, res) => {
    if (!checkApiKey(req.headers.authorization, config)) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      sessions.delete(sessionId);
      res.status(200).json({ status: "session closed" });
    } else {
      res.status(404).json({ error: "Session not found" });
    }
  });

  return { app, poolManager };
}
