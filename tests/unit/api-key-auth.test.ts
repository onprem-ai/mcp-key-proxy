import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { validateApiKeyConfig, checkApiKey } from "../../src/api-key-auth.js";
import type { Config } from "../../src/types.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    stdioCommand: "echo",
    headerMappings: [],
    port: 8000,
    host: "0.0.0.0",
    poolSize: 5,
    ttlSeconds: 300,
    queueTimeoutSeconds: 30,
    debug: false,
    corsOrigins: [],
    ...overrides,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("validateApiKeyConfig", () => {
  it("passes with no api key config", () => {
    expect(() => validateApiKeyConfig(makeConfig())).not.toThrow();
  });

  it("passes with only --api-key", () => {
    expect(() => validateApiKeyConfig(makeConfig({ apiKey: "secret" }))).not.toThrow();
  });

  it("passes with only --api-key-sha256", () => {
    expect(() =>
      validateApiKeyConfig(makeConfig({ apiKeySha256: sha256("secret") })),
    ).not.toThrow();
  });

  it("throws when both --api-key and --api-key-sha256 are set", () => {
    expect(() =>
      validateApiKeyConfig(makeConfig({ apiKey: "secret", apiKeySha256: sha256("secret") })),
    ).toThrow("mutually exclusive");
  });

  it("throws when --api-key-sha256 is not a valid hex string", () => {
    expect(() =>
      validateApiKeyConfig(makeConfig({ apiKeySha256: "not-a-hex" })),
    ).toThrow("64-character hex string");
  });

  it("throws when --api-key-sha256 is too short", () => {
    expect(() =>
      validateApiKeyConfig(makeConfig({ apiKeySha256: "abcd1234" })),
    ).toThrow("64-character hex string");
  });

  it("throws when --api-key is empty string", () => {
    expect(() =>
      validateApiKeyConfig(makeConfig({ apiKey: "" })),
    ).toThrow("must not be empty");
  });

  it("throws when --api-key-sha256 is empty string", () => {
    expect(() =>
      validateApiKeyConfig(makeConfig({ apiKeySha256: "" })),
    ).toThrow("must not be empty");
  });
});

describe("checkApiKey", () => {
  describe("no auth configured", () => {
    it("allows any request", () => {
      expect(checkApiKey(undefined, makeConfig())).toBe(true);
      expect(checkApiKey("Bearer anything", makeConfig())).toBe(true);
    });
  });

  describe("--api-key (plain text)", () => {
    const config = makeConfig({ apiKey: "sk-test-key-123" });

    it("accepts correct Bearer token", () => {
      expect(checkApiKey("Bearer sk-test-key-123", config)).toBe(true);
    });

    it("rejects wrong key", () => {
      expect(checkApiKey("Bearer wrong-key", config)).toBe(false);
    });

    it("rejects missing Authorization header", () => {
      expect(checkApiKey(undefined, config)).toBe(false);
    });

    it("rejects empty Authorization header", () => {
      expect(checkApiKey("", config)).toBe(false);
    });

    it("rejects non-Bearer scheme", () => {
      expect(checkApiKey("Basic sk-test-key-123", config)).toBe(false);
    });

    it("is case-insensitive for Bearer prefix", () => {
      expect(checkApiKey("bearer sk-test-key-123", config)).toBe(true);
      expect(checkApiKey("BEARER sk-test-key-123", config)).toBe(true);
    });

    it("trims trailing whitespace from token", () => {
      expect(checkApiKey("Bearer sk-test-key-123   ", config)).toBe(true);
    });
  });

  describe("--api-key-sha256", () => {
    const secret = "sk-test-key-456";
    const config = makeConfig({ apiKeySha256: sha256(secret) });

    it("accepts correct Bearer token", () => {
      expect(checkApiKey(`Bearer ${secret}`, config)).toBe(true);
    });

    it("rejects wrong key", () => {
      expect(checkApiKey("Bearer wrong-key", config)).toBe(false);
    });

    it("rejects missing Authorization header", () => {
      expect(checkApiKey(undefined, config)).toBe(false);
    });

    it("works with uppercase hex in config", () => {
      const upperConfig = makeConfig({ apiKeySha256: sha256(secret).toUpperCase() });
      expect(checkApiKey(`Bearer ${secret}`, upperConfig)).toBe(true);
    });
  });
});
