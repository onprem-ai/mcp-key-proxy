import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/server.js";
import type { Config } from "../../src/types.js";
import type { PoolManager } from "../../src/pool-manager.js";

const config: Config = {
  stdioCommand: "npx tsx tests/fixtures/echo-server.ts",
  headerMappings: [{ headerName: "x-api-key", envVar: "ECHO_API_KEY" }],
  port: 0,
  host: "127.0.0.1",
  poolSize: 3,
  ttlSeconds: 60,
  queueTimeoutSeconds: 5,
  debug: false,
  corsOrigins: ["*"],
};

let server: Server;
let poolManager: PoolManager;
let baseUrl: string;

beforeAll(async () => {
  const result = createApp(config);
  poolManager = result.poolManager;

  await new Promise<void>((resolve) => {
    server = result.app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await poolManager.destroyAll();
});

function mcpHeaders(apiKey: string, sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
  if (sessionId) {
    h["Mcp-Session-Id"] = sessionId;
  }
  return h;
}

function initializeRequest(id: number = 1) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  };
}

function initializedNotification() {
  return {
    jsonrpc: "2.0" as const,
    method: "notifications/initialized",
  };
}

function toolsCallRequest(id: number = 3) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call",
    params: {
      name: "echo",
      arguments: { message: "hello" },
    },
  };
}

/** Helper: initialize a session and return the session ID. */
async function initializeSession(apiKey: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: mcpHeaders(apiKey),
    body: JSON.stringify(initializeRequest()),
  });
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("Mcp-Session-Id");
  expect(sessionId).toBeTruthy();

  // Send initialized notification
  const notifRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: mcpHeaders(apiKey, sessionId!),
    body: JSON.stringify(initializedNotification()),
  });
  expect(notifRes.status).toBe(202);

  return sessionId!;
}

describe("Server integration tests", () => {
  it("GET /health returns status ok with expected fields", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("pools");
    expect(body).toHaveProperty("totalWorkers");
    expect(typeof body.totalWorkers).toBe("number");
    expect(body).toHaveProperty("uptime");
    expect(typeof body.uptime).toBe("number");
  });

  it("POST /mcp without x-api-key returns 401", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initializeRequest()),
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("POST /mcp with initialize request returns protocolVersion and Mcp-Session-Id", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders("test-key-123"),
      body: JSON.stringify(initializeRequest()),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.result).toBeDefined();
    expect(body.result.protocolVersion).toBe("2024-11-05");

    const sessionId = res.headers.get("Mcp-Session-Id");
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe("string");
  });

  it("Full tool call: initialize then tools/call returns echoed ECHO_API_KEY", async () => {
    const apiKey = "full-flow-key-456";
    const sessionId = await initializeSession(apiKey);

    // Call tool
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(apiKey, sessionId),
      body: JSON.stringify(toolsCallRequest()),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.result).toBeDefined();
    expect(body.result.content).toBeInstanceOf(Array);
    expect(body.result.content.length).toBeGreaterThan(0);

    const text = JSON.parse(body.result.content[0].text);
    expect(text.echoApiKey).toBe(apiKey);
    expect(text.toolName).toBe("echo");
    expect(text.args).toEqual({ message: "hello" });
  });

  it("Multi-tenant isolation: different x-api-key values yield different ECHO_API_KEY", async () => {
    const keyA = "tenant-a-key";
    const keyB = "tenant-b-key";

    const sessionA = await initializeSession(keyA);
    const sessionB = await initializeSession(keyB);

    // Call tool with tenant A
    const resA = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(keyA, sessionA),
      body: JSON.stringify(toolsCallRequest(10)),
    });
    expect(resA.status).toBe(200);
    const bodyA = await resA.json();
    const textA = JSON.parse(bodyA.result.content[0].text);

    // Call tool with tenant B
    const resB = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(keyB, sessionB),
      body: JSON.stringify(toolsCallRequest(11)),
    });
    expect(resB.status).toBe(200);
    const bodyB = await resB.json();
    const textB = JSON.parse(bodyB.result.content[0].text);

    expect(textA.echoApiKey).toBe(keyA);
    expect(textB.echoApiKey).toBe(keyB);
    expect(textA.echoApiKey).not.toBe(textB.echoApiKey);
  });

  it("Session management: initialize gets session, reuse works, DELETE closes it", async () => {
    const apiKey = "session-mgmt-key";
    const sessionId = await initializeSession(apiKey);

    // Subsequent request with the session ID works
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(apiKey, sessionId),
      body: JSON.stringify(toolsCallRequest(20)),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Mcp-Session-Id")).toBe(sessionId);

    // DELETE the session
    const delRes = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": sessionId },
    });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.status).toBe("session closed");

    // DELETE again should return 404
    const delRes2 = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": sessionId },
    });
    expect(delRes2.status).toBe(404);
  });

  it("POST /mcp with invalid JSON returns 400", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key-123",
      },
      body: "not valid json {{{",
    });
    expect(res.status).toBe(400);
  });

  it("OPTIONS request returns CORS headers", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, x-api-key",
      },
    });

    // CORS preflight should succeed (typically 204 or 200)
    expect(res.status).toBeLessThan(400);

    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(res.headers.get("access-control-allow-methods")).toBeTruthy();
  });
});
