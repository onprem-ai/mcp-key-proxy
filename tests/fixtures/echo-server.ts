#!/usr/bin/env node

/**
 * Minimal MCP stdio echo server for testing.
 * - Responds to `initialize` with server info.
 * - Responds to `tools/list` with a dummy tool.
 * - Responds to `tools/call` echoing args + env var values.
 * - Reads API key from ECHO_API_KEY env var to prove header→env injection.
 */

import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line: string) => {
  let msg: { jsonrpc: string; id?: string | number; method?: string; params?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Skip notifications (no id)
  if (msg.id === undefined || msg.id === null) return;

  let result: unknown;

  switch (msg.method) {
    case "initialize":
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "echo-server", version: "1.0.0" },
      };
      break;

    case "tools/list":
      result = {
        tools: [
          {
            name: "echo",
            description: "Echoes input and env vars",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
            },
          },
        ],
      };
      break;

    case "tools/call": {
      const params = msg.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              echoApiKey: process.env.ECHO_API_KEY ?? null,
              toolName: params?.name,
              args: params?.arguments,
              pid: process.pid,
            }),
          },
        ],
      };
      break;
    }

    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        }) + "\n",
      );
      return;
  }

  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n",
  );
});
