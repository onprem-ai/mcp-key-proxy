import {
  createHash,
  timingSafeEqual as cryptoTimingSafeEqual,
} from "node:crypto";
import { log } from "./logger.js";
import type { Config } from "./types.js";

export function validateApiKeyConfig(config: Config): void {
  if (config.apiKey && config.apiKeySha256) {
    throw new Error("--api-key and --api-key-sha256 are mutually exclusive");
  }
  if (config.apiKey !== undefined && config.apiKey.length === 0) {
    throw new Error("--api-key must not be empty");
  }
  if (config.apiKeySha256 !== undefined && config.apiKeySha256.length === 0) {
    throw new Error("--api-key-sha256 must not be empty");
  }
  if (config.apiKeySha256 && !/^[0-9a-f]{64}$/i.test(config.apiKeySha256)) {
    throw new Error("--api-key-sha256 must be a 64-character hex string");
  }
}

export function checkApiKey(
  authHeader: string | undefined,
  config: Config,
): boolean {
  const expected = config.apiKey;
  const expectedHash = config.apiKeySha256?.toLowerCase();

  if (!expected && !expectedHash) {
    return true;
  }

  const token = parseBearerToken(authHeader);
  if (!token) {
    log.warn("api-key auth failed: missing or malformed Authorization header");
    return false;
  }

  const tokenHash = sha256(token);
  const referenceHash = expectedHash ?? sha256(expected!);
  return timingSafeCompare(tokenHash, referenceHash);
}

function parseBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return cryptoTimingSafeEqual(bufA, bufB);
}
