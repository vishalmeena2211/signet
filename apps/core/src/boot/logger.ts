// Structured JSON logger implementing the domain Logger port. Zero deps:
// one line of JSON per event on stdout, correlation context merged in.
// (console.* is policy-banned; process.stdout is the sanctioned sink.)

import type { LogContext, Logger, LogLevel } from "../domain/runtime/logger.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function makeLogger(minLevel: LogLevel, base: LogContext = {}): Logger {
  const emit = (level: LogLevel, event: string, ctx?: LogContext) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    process.stdout.write(
      JSON.stringify({ t: new Date().toISOString(), level, event, ...base, ...ctx }) + "\n",
    );
  };
  return {
    debug: (e, c) => emit("debug", e, c),
    info: (e, c) => emit("info", e, c),
    warn: (e, c) => emit("warn", e, c),
    error: (e, c) => emit("error", e, c),
    child: (ctx) => makeLogger(minLevel, { ...base, ...ctx }),
  };
}
