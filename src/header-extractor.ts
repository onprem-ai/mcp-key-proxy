import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { HeaderMapping } from "./types.js";

export function parseHeaderMappings(raw: string[]): HeaderMapping[] {
  return raw.map((entry) => {
    const eqIdx = entry.indexOf("=");
    if (eqIdx < 1) {
      throw new Error(
        `Invalid header-to-env mapping "${entry}": expected "Header-Name=ENV_VAR"`,
      );
    }
    const headerName = entry.slice(0, eqIdx).toLowerCase();
    const envVar = entry.slice(eqIdx + 1);
    if (!envVar) {
      throw new Error(
        `Invalid header-to-env mapping "${entry}": env var name is empty`,
      );
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
      throw new Error(
        `Invalid env var name "${envVar}": must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
      );
    }
    return { headerName, envVar };
  });
}

export interface ExtractResult {
  envVars: Record<string, string>;
  poolKey: string;
}

export function extractHeaders(
  headers: IncomingHttpHeaders,
  mappings: HeaderMapping[],
): ExtractResult {
  if (mappings.length === 0) {
    return { envVars: {}, poolKey: "shared" };
  }

  const envVars: Record<string, string> = {};

  for (const { headerName, envVar } of mappings) {
    const value = headers[headerName];
    if (value === undefined || value === null) {
      throw new MissingHeaderError(headerName);
    }
    const strValue = Array.isArray(value) ? value[0] : value;
    if (!strValue) {
      throw new MissingHeaderError(headerName);
    }
    validateHeaderValue(headerName, strValue);
    envVars[envVar] = strValue;
  }

  const sorted = Object.entries(envVars).sort(([a], [b]) => a.localeCompare(b));
  const poolKey = createHash("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex")
    .slice(0, 16);

  return { envVars, poolKey };
}

function validateHeaderValue(headerName: string, value: string): void {
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new InvalidHeaderError(headerName);
  }
}

export class MissingHeaderError extends Error {
  public readonly headerName: string;
  constructor(headerName: string) {
    super(`Missing required header: ${headerName}`);
    this.name = "MissingHeaderError";
    this.headerName = headerName;
  }
}

export class InvalidHeaderError extends Error {
  public readonly headerName: string;
  constructor(headerName: string) {
    super(`Invalid value for header: ${headerName}`);
    this.name = "InvalidHeaderError";
    this.headerName = headerName;
  }
}
