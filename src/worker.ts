import { spawn, type ChildProcess } from "node:child_process";
import { log } from "./logger.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

const KILL_TIMEOUT_MS = 5000;
const RESPONSE_TIMEOUT_MS = 30000;

export class Worker {
  private proc: ChildProcess | null = null;
  private readBuffer = "";
  private pendingRequests = new Map<
    string | number,
    {
      resolve: (resp: JsonRpcResponse) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private initialized = false;

  constructor(
    private readonly command: string,
    private readonly envVars: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    const parts = this.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [
      this.command,
    ];
    const cmd = parts[0].replace(/^["']|["']$/g, "");
    const args = parts.slice(1).map((a) => a.replace(/^["']|["']$/g, ""));

    const env: Record<string, string> = {};
    // Inherit safe env vars
    for (const key of [
      "PATH",
      "HOME",
      "TMPDIR",
      "USER",
      "LANG",
      "NODE_PATH",
      "npm_config_prefix",
    ]) {
      if (process.env[key]) {
        env[key] = process.env[key]!;
      }
    }
    // Apply injected env vars
    Object.assign(env, this.envVars);

    this.proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.readBuffer += chunk.toString();
      this.processBuffer();
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      log.debug("worker stderr", { pid: this.proc?.pid, data: chunk.toString().trim() });
    });

    this.proc.on("exit", (code, signal) => {
      log.info("worker exited", { pid: this.proc?.pid, code, signal });
      this.rejectAll(new Error(`Worker exited: code=${code} signal=${signal}`));
      this.proc = null;
    });

    this.proc.on("error", (err) => {
      log.error("worker spawn error", { error: err.message });
      this.rejectAll(err);
      this.proc = null;
    });
  }

  async initialize(): Promise<JsonRpcResponse> {
    if (this.initialized) {
      throw new Error("Worker already initialized");
    }
    const resp = await this.send({
      jsonrpc: "2.0",
      id: "__init__",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-key-proxy", version: "0.1.0" },
      },
    });
    // Send initialized notification
    await this.sendNotification({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    this.initialized = true;
    return resp;
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.proc?.stdin?.writable) {
      throw new Error("Worker process not running");
    }
    if (request.id === undefined) {
      throw new Error("Request must have an id");
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(request.id!);
        reject(new Error(`Worker response timeout for request ${request.id}`));
      }, RESPONSE_TIMEOUT_MS);

      this.pendingRequests.set(request.id!, { resolve, reject, timer });
      this.proc!.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  async sendNotification(notification: { jsonrpc: "2.0"; method: string; params?: unknown }): Promise<void> {
    if (!this.proc?.stdin?.writable) {
      throw new Error("Worker process not running");
    }
    this.proc.stdin.write(JSON.stringify(notification) + "\n");
  }

  private processBuffer(): void {
    const lines = this.readBuffer.split("\n");
    this.readBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && msg.id !== null) {
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.id);
            pending.resolve(msg);
          }
        }
      } catch {
        log.debug("worker: non-JSON stdout line", { line: trimmed });
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
  }

  isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async destroy(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.rejectAll(new Error("Worker destroyed"));

    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, KILL_TIMEOUT_MS);
      proc.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
