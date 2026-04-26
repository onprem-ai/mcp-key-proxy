type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];
}

function emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const log = {
  error(msg: string, extra?: Record<string, unknown>): void {
    emit("error", msg, extra);
  },
  warn(msg: string, extra?: Record<string, unknown>): void {
    emit("warn", msg, extra);
  },
  info(msg: string, extra?: Record<string, unknown>): void {
    emit("info", msg, extra);
  },
  debug(msg: string, extra?: Record<string, unknown>): void {
    emit("debug", msg, extra);
  },
};
