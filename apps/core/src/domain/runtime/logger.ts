// Structured logger port. One logger, typed event names, correlation ids on
// every line. Implementations live in boot (pino behind the port); domain and
// services log only through this.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  runId?: string;
  incrementId?: string;
  featureId?: string;
  phase?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface Logger {
  debug(event: string, ctx?: LogContext): void;
  info(event: string, ctx?: LogContext): void;
  warn(event: string, ctx?: LogContext): void;
  error(event: string, ctx?: LogContext & { error?: string }): void;
  child(ctx: LogContext): Logger;
}
