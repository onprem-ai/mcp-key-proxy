export interface HeaderMapping {
  headerName: string;
  envVar: string;
}

export interface Config {
  stdioCommand: string;
  headerMappings: HeaderMapping[];
  port: number;
  host: string;
  poolSize: number;
  ttlSeconds: number;
  queueTimeoutSeconds: number;
  debug: boolean;
  corsOrigins: string[];
}

export interface PoolStats {
  size: number;
  available: number;
  borrowed: number;
  pending: number;
}

export interface HealthResponse {
  status: "ok" | "error";
  pools: Record<string, PoolStats>;
  totalWorkers: number;
  uptime: number;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
