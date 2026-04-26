#!/usr/bin/env node

import { Command } from "commander";
import { createApp } from "./server.js";
import { parseHeaderMappings } from "./header-extractor.js";
import { setLogLevel, log } from "./logger.js";
import type { Config } from "./types.js";

const program = new Command();

program
  .name("mcp-key-proxy")
  .description(
    "Streamable HTTP proxy for stdio MCP servers with per-request API key injection via headers",
  )
  .version("0.1.0")
  .requiredOption("--stdio <command>", "Shell command to spawn the stdio MCP server")
  .option(
    "--header-to-env <mapping>",
    "Header→env mapping (Header-Name=ENV_VAR). Repeatable.",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option("--port <number>", "HTTP listen port", "8000")
  .option("--host <string>", "Bind address", "0.0.0.0")
  .option("--pool-size <number>", "Max processes per API key", "5")
  .option("--ttl <seconds>", "Idle process TTL in seconds", "300")
  .option("--queue-timeout <seconds>", "Max seconds to wait for a process", "30")
  .option("--debug", "Verbose structured JSON logging", false)
  .option(
    "--cors <origin>",
    "CORS allowed origin. Repeatable.",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  );

program.parse();

const opts = program.opts();

if (opts.debug) {
  setLogLevel("debug");
}

let headerMappings;
try {
  headerMappings = parseHeaderMappings(opts.headerToEnv);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

if (headerMappings.length === 0) {
  log.info("no --header-to-env mappings: all requests share a single process pool");
}

const config: Config = {
  stdioCommand: opts.stdio,
  headerMappings,
  port: parseInt(opts.port, 10),
  host: opts.host,
  poolSize: parseInt(opts.poolSize, 10),
  ttlSeconds: parseInt(opts.ttl, 10),
  queueTimeoutSeconds: parseInt(opts.queueTimeout, 10),
  debug: opts.debug,
  corsOrigins: opts.cors,
};

const { app, poolManager } = createApp(config);

const server = app.listen(config.port, config.host, () => {
  log.info("mcp-key-proxy started", {
    port: config.port,
    host: config.host,
    command: config.stdioCommand,
    mappings: headerMappings.map((m) => `${m.headerName}→${m.envVar}`),
    poolSize: config.poolSize,
    ttlSeconds: config.ttlSeconds,
  });
});

async function shutdown() {
  log.info("shutting down");
  await poolManager.destroyAll();
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
