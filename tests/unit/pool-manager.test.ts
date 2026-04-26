import { describe, it, expect, afterEach } from "vitest";
import { PoolManager } from "../../src/pool-manager.js";
import type { Config } from "../../src/types.js";

const config: Config = {
  stdioCommand: "npx tsx tests/fixtures/echo-server.ts",
  headerMappings: [],
  port: 0,
  host: "127.0.0.1",
  poolSize: 3,
  ttlSeconds: 60,
  queueTimeoutSeconds: 5,
  debug: false,
  corsOrigins: [],
};

/** Helper to extract PID from a worker via the echo server's tools/call response. */
async function getWorkerPid(worker: Awaited<ReturnType<PoolManager["acquire"]>>): Promise<number> {
  const resp = await worker.send({
    jsonrpc: "2.0",
    id: "pid-check",
    method: "tools/call",
    params: { name: "echo", arguments: { message: "ping" } },
  });
  const text = (resp.result as { content: { type: string; text: string }[] }).content[0].text;
  return JSON.parse(text).pid as number;
}

describe("PoolManager", () => {
  let poolManager: PoolManager;

  afterEach(async () => {
    await poolManager.destroyAll();
  });

  it("acquire() creates a pool and returns a worker for a new key", async () => {
    poolManager = new PoolManager(config);

    const worker = await poolManager.acquire("key-a", { ECHO_API_KEY: "aaa" });

    expect(worker).toBeDefined();
    expect(worker.isAlive()).toBe(true);
    expect(worker.isInitialized()).toBe(true);

    poolManager.release("key-a", worker);
  });

  it("acquire() reuses existing pool for same key", async () => {
    poolManager = new PoolManager(config);

    const worker1 = await poolManager.acquire("key-b", { ECHO_API_KEY: "bbb" });
    const worker2 = await poolManager.acquire("key-b", { ECHO_API_KEY: "bbb" });

    // Both workers come from the same pool — stats should show one pool with key-b
    const stats = poolManager.getStats();
    expect(stats["key-b"]).toBeDefined();
    expect(stats["key-b"].borrowed).toBe(2);

    poolManager.release("key-b", worker1);
    poolManager.release("key-b", worker2);
  });

  it("release() makes worker available for reuse — same PID after acquire-release-acquire", async () => {
    poolManager = new PoolManager(config);

    const worker1 = await poolManager.acquire("key-c", { ECHO_API_KEY: "ccc" });
    const pid1 = await getWorkerPid(worker1);
    poolManager.release("key-c", worker1);

    const worker2 = await poolManager.acquire("key-c", { ECHO_API_KEY: "ccc" });
    const pid2 = await getWorkerPid(worker2);
    poolManager.release("key-c", worker2);

    expect(pid1).toBe(pid2);
  });

  it("different keys get different workers with different env vars", async () => {
    poolManager = new PoolManager(config);

    const workerA = await poolManager.acquire("key-d", { ECHO_API_KEY: "ddd" });
    const workerB = await poolManager.acquire("key-e", { ECHO_API_KEY: "eee" });

    const respA = await workerA.send({
      jsonrpc: "2.0",
      id: "env-a",
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    });
    const respB = await workerB.send({
      jsonrpc: "2.0",
      id: "env-b",
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    });

    const textA = (respA.result as { content: { type: string; text: string }[] }).content[0].text;
    const textB = (respB.result as { content: { type: string; text: string }[] }).content[0].text;

    expect(JSON.parse(textA).echoApiKey).toBe("ddd");
    expect(JSON.parse(textB).echoApiKey).toBe("eee");

    // They should be in separate pools
    const stats = poolManager.getStats();
    expect(stats["key-d"]).toBeDefined();
    expect(stats["key-e"]).toBeDefined();

    poolManager.release("key-d", workerA);
    poolManager.release("key-e", workerB);
  });

  it("getStats() returns correct counts", async () => {
    poolManager = new PoolManager(config);

    const worker1 = await poolManager.acquire("key-f", { ECHO_API_KEY: "fff" });
    const worker2 = await poolManager.acquire("key-f", { ECHO_API_KEY: "fff" });

    const stats = poolManager.getStats();
    expect(stats["key-f"]).toEqual({
      size: 2,
      available: 0,
      borrowed: 2,
      pending: 0,
    });

    poolManager.release("key-f", worker1);

    const stats2 = poolManager.getStats();
    expect(stats2["key-f"].available).toBe(1);
    expect(stats2["key-f"].borrowed).toBe(1);

    poolManager.release("key-f", worker2);
  });

  it("getTotalWorkers() counts across pools", async () => {
    poolManager = new PoolManager(config);

    const w1 = await poolManager.acquire("key-g", { ECHO_API_KEY: "ggg" });
    const w2 = await poolManager.acquire("key-h", { ECHO_API_KEY: "hhh" });
    const w3 = await poolManager.acquire("key-h", { ECHO_API_KEY: "hhh" });

    expect(poolManager.getTotalWorkers()).toBe(3);

    poolManager.release("key-g", w1);
    poolManager.release("key-h", w2);
    poolManager.release("key-h", w3);
  });

  it("destroyAll() cleans up all pools", async () => {
    poolManager = new PoolManager(config);

    const w1 = await poolManager.acquire("key-i", { ECHO_API_KEY: "iii" });
    const w2 = await poolManager.acquire("key-j", { ECHO_API_KEY: "jjj" });

    poolManager.release("key-i", w1);
    poolManager.release("key-j", w2);

    await poolManager.destroyAll();

    const stats = poolManager.getStats();
    expect(Object.keys(stats)).toHaveLength(0);
    expect(poolManager.getTotalWorkers()).toBe(0);
  });
});
