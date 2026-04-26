import { describe, it, expect, afterEach } from "vitest";
import { Worker } from "../../src/worker.js";

const ECHO_CMD = "npx tsx tests/fixtures/echo-server.ts";

describe("Worker", () => {
  let worker: Worker | null = null;

  afterEach(async () => {
    if (worker) {
      await worker.destroy();
      worker = null;
    }
  });

  it("starts and initializes with the echo server fixture", async () => {
    worker = new Worker(ECHO_CMD, {});
    await worker.start();
    const resp = await worker.initialize();

    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe("__init__");
    expect(resp.result).toBeDefined();

    const result = resp.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
    };
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.serverInfo.name).toBe("echo-server");
  });

  it("sends a tools/call request and gets back the echoed response with the correct env var", async () => {
    const apiKey = "test-key-42";
    worker = new Worker(ECHO_CMD, { ECHO_API_KEY: apiKey });
    await worker.start();
    await worker.initialize();

    const resp = await worker.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "hello" } },
    });

    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(1);
    expect(resp.result).toBeDefined();

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    const payload = JSON.parse(result.content[0].text);
    expect(payload.echoApiKey).toBe(apiKey);
    expect(payload.toolName).toBe("echo");
    expect(payload.args).toEqual({ message: "hello" });
  });

  it("isAlive() returns true after start, false after destroy", async () => {
    worker = new Worker(ECHO_CMD, {});
    await worker.start();
    await worker.initialize();

    expect(worker.isAlive()).toBe(true);

    await worker.destroy();
    expect(worker.isAlive()).toBe(false);

    // Prevent afterEach from calling destroy again
    worker = null;
  });

  it("destroy() kills the child process", async () => {
    worker = new Worker(ECHO_CMD, {});
    await worker.start();
    await worker.initialize();

    expect(worker.isAlive()).toBe(true);

    await worker.destroy();
    expect(worker.isAlive()).toBe(false);

    // Sending after destroy should fail
    await expect(
      worker.send({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ).rejects.toThrow("Worker process not running");

    worker = null;
  });

  it("send() rejects when process is not running", async () => {
    worker = new Worker(ECHO_CMD, {});
    // Never started — process is null

    await expect(
      worker.send({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    ).rejects.toThrow("Worker process not running");
  });

  it("passes env vars correctly (ECHO_API_KEY=test123)", async () => {
    worker = new Worker(ECHO_CMD, { ECHO_API_KEY: "test123" });
    await worker.start();
    await worker.initialize();

    const resp = await worker.send({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    });

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    const payload = JSON.parse(result.content[0].text);
    expect(payload.echoApiKey).toBe("test123");
  });
});
