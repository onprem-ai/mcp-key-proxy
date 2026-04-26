import { describe, it, expect } from "vitest";
import {
  parseHeaderMappings,
  extractHeaders,
  MissingHeaderError,
  InvalidHeaderError,
} from "../../src/header-extractor.js";

describe("parseHeaderMappings", () => {
  it("parses a valid single mapping", () => {
    const result = parseHeaderMappings(["X-Api-Key=API_KEY"]);
    expect(result).toEqual([{ headerName: "x-api-key", envVar: "API_KEY" }]);
  });

  it("parses multiple mappings", () => {
    const result = parseHeaderMappings([
      "X-Api-Key=API_KEY",
      "Authorization=AUTH_TOKEN",
    ]);
    expect(result).toEqual([
      { headerName: "x-api-key", envVar: "API_KEY" },
      { headerName: "authorization", envVar: "AUTH_TOKEN" },
    ]);
  });

  it("throws on invalid format with no '='", () => {
    expect(() => parseHeaderMappings(["NoEqualsHere"])).toThrow(
      /Invalid header-to-env mapping.*expected/,
    );
  });

  it("throws when env var name is empty", () => {
    expect(() => parseHeaderMappings(["X-Api-Key="])).toThrow(
      /env var name is empty/,
    );
  });

  it("throws when env var contains invalid characters", () => {
    expect(() => parseHeaderMappings(["X-Api-Key=INVALID-VAR"])).toThrow(
      /Invalid env var name/,
    );
    expect(() => parseHeaderMappings(["X-Api-Key=1STARTS_WITH_DIGIT"])).toThrow(
      /Invalid env var name/,
    );
  });
});

describe("extractHeaders", () => {
  const mappings = parseHeaderMappings([
    "X-Api-Key=API_KEY",
    "X-Tenant=TENANT_ID",
  ]);

  it("extracts correct env vars from headers", () => {
    const { envVars } = extractHeaders(
      { "x-api-key": "secret123", "x-tenant": "acme" },
      mappings,
    );
    expect(envVars).toEqual({ API_KEY: "secret123", TENANT_ID: "acme" });
  });

  it("computes a deterministic pool key", () => {
    const headers = { "x-api-key": "secret123", "x-tenant": "acme" };
    const { poolKey: key1 } = extractHeaders(headers, mappings);
    const { poolKey: key2 } = extractHeaders(headers, mappings);
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(16);
  });

  it("produces the same pool key regardless of header order in mappings", () => {
    const mappingsReversed = parseHeaderMappings([
      "X-Tenant=TENANT_ID",
      "X-Api-Key=API_KEY",
    ]);
    const headers = { "x-api-key": "secret123", "x-tenant": "acme" };
    const { poolKey: key1 } = extractHeaders(headers, mappings);
    const { poolKey: key2 } = extractHeaders(headers, mappingsReversed);
    expect(key1).toBe(key2);
  });

  it("throws MissingHeaderError when a required header is absent", () => {
    expect(() =>
      extractHeaders({ "x-api-key": "secret123" }, mappings),
    ).toThrow(MissingHeaderError);
  });

  it("throws InvalidHeaderError when value contains a newline", () => {
    expect(() =>
      extractHeaders(
        { "x-api-key": "bad\nvalue", "x-tenant": "acme" },
        mappings,
      ),
    ).toThrow(InvalidHeaderError);
  });

  it("throws InvalidHeaderError when value contains a carriage return", () => {
    expect(() =>
      extractHeaders(
        { "x-api-key": "bad\rvalue", "x-tenant": "acme" },
        mappings,
      ),
    ).toThrow(InvalidHeaderError);
  });

  it("throws InvalidHeaderError when value contains a null byte", () => {
    expect(() =>
      extractHeaders(
        { "x-api-key": "bad\0value", "x-tenant": "acme" },
        mappings,
      ),
    ).toThrow(InvalidHeaderError);
  });

  it("handles array header values by taking the first element", () => {
    const { envVars } = extractHeaders(
      {
        "x-api-key": ["first", "second"] as unknown as string,
        "x-tenant": "acme",
      },
      mappings,
    );
    expect(envVars.API_KEY).toBe("first");
  });
});
