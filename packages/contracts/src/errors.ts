// Closed error taxonomy. Errors are typed values; the triad (recoverable /
// non-recoverable / conflict) drives retry behaviour everywhere:
//   recoverable      → unlock, retry later
//   non_recoverable  → record outcome, finish (no retry)
//   conflict         → another actor holds the resource; caller backs off
// `never`-checked switches over `kind` keep handling exhaustive.

import { z } from "zod";

export const ErrorKindSchema = z.enum(["recoverable", "non_recoverable", "conflict"]);
export type ErrorKind = z.infer<typeof ErrorKindSchema>;

export const SignetErrorSchema = z.object({
  kind: ErrorKindSchema,
  code: z.string().min(1), // machine-stable, e.g. "adapter.limit_reached"
  message: z.string(),
  correlationId: z.string().optional(),
  cause: z.string().optional(), // stringified upstream error, never a live object
});
export type SignetError = z.infer<typeof SignetErrorSchema>;

export function recoverable(code: string, message: string, extra?: Partial<SignetError>): SignetError {
  return { kind: "recoverable", code, message, ...extra };
}
export function nonRecoverable(code: string, message: string, extra?: Partial<SignetError>): SignetError {
  return { kind: "non_recoverable", code, message, ...extra };
}
export function conflict(code: string, message: string, extra?: Partial<SignetError>): SignetError {
  return { kind: "conflict", code, message, ...extra };
}

/** Exhaustiveness helper: `default: return assertNever(x)` */
export function assertNever(value: never): never {
  throw new Error(`unreachable variant: ${JSON.stringify(value)}`);
}
