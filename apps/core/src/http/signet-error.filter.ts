// Turns the domain's typed errors into HTTP answers a human can read.
//
// Without this every refused action arrives at the console as
// `500 Internal server error`, so a button that is legitimately not allowed
// right now is indistinguishable from a crash — the console looks broken and
// the user cannot tell what to do instead. The triad already tells us the
// status; this only has to supply the sentence.

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { SignetErrorSchema, assertNever, type ErrorKind, type SignetError } from "@signet/contracts";
import type { Logger } from "../domain/runtime/logger.js";

function statusFor(kind: ErrorKind, code: string): HttpStatus {
  // "It isn't there" is a 404 whatever its retry classification says.
  if (code.endsWith(".not_found")) return HttpStatus.NOT_FOUND;
  switch (kind) {
    case "conflict":
      return HttpStatus.CONFLICT;
    case "recoverable":
      return HttpStatus.SERVICE_UNAVAILABLE;
    case "non_recoverable":
      return HttpStatus.UNPROCESSABLE_ENTITY;
    default:
      return assertNever(kind);
  }
}

/**
 * Plain language for the refusals the console can actually provoke. The code
 * stays in the payload for machines; the sentence is what the user reads.
 */
const SENTENCE: Record<string, (detail: string) => string> = {
  "increment.illegal_transition": (d) =>
    `this increment is not in a state where that is possible (${d}). Reload — someone or something already moved it.`,
  "increment.concurrent_transition": (d) =>
    `the increment changed while you were looking at it (${d}). Reload to see where it got to.`,
  "quota.exhausted": () =>
    "the Claude Code quota window is exhausted. Parked work resumes by itself when the window resets.",
  "increment.not_found": () => "that step no longer exists.",
  "feature.not_found": () => "that feature no longer exists.",
  "increment.corrupt_state": (d) =>
    `${d} This is a data problem on our side, not something you did.`,
};

function humanise(err: SignetError): string {
  const phrase = SENTENCE[err.code];
  return phrase ? phrase(err.message) : err.message;
}

/**
 * The typed error, whether the domain attached it to a thrown Error or threw the typed
 * error itself. Two endpoints threw it bare, and a new user's first ask came back as
 * "That did not work: [object Object]", with the reason lost from the log too.
 */
function signetErrorOf(e: unknown): SignetError | null {
  if (typeof e !== "object" || e === null) return null;
  const parsed = SignetErrorSchema.safeParse("signet" in e ? (e as { signet: unknown }).signet : e);
  return parsed.success ? parsed.data : null;
}

@Catch()
export class SignetErrorFilter implements ExceptionFilter {
  constructor(private readonly log: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    const domain = signetErrorOf(exception);
    if (domain) {
      const status = statusFor(domain.kind, domain.code);
      this.log.info("http.refused", { code: domain.code, kind: domain.kind, status });
      res.status(status).json({ statusCode: status, code: domain.code, message: humanise(domain) });
      return;
    }

    // A bad request body is the caller's mistake, not a server fault. Zod's
    // issue list is precise but unreadable raw, so it becomes one sentence per
    // field naming the path that was wrong.
    if (exception instanceof ZodError) {
      const detail = exception.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ statusCode: 400, code: "request.invalid", message: detail });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(typeof body === "string" ? { statusCode: status, message: body } : body);
      return;
    }

    // Genuinely unexpected: log it in full, but still tell the console
    // something more useful than "Internal server error".
    // Never "[object Object]": an object is shown as what it holds.
    const message =
      exception instanceof Error
        ? exception.message
        : typeof exception === "object" && exception !== null
          ? JSON.stringify(exception)
          : String(exception);
    this.log.error("http.unhandled", {
      message,
      stack: exception instanceof Error ? exception.stack : undefined,
    });
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: 500, code: "unexpected", message });
  }
}
