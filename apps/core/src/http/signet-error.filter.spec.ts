// What a person sees when something goes wrong: the reason, never "[object Object]".

import { describe, expect, it } from "vitest";
import type { ArgumentsHost } from "@nestjs/common";
import { SignetErrorFilter } from "./signet-error.filter.js";
import type { Logger } from "../domain/runtime/logger.js";

const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => nullLogger };

function send(exception: unknown): { status: number; body: { message: string; code?: string } } {
  const out = { status: 0, body: { message: "" } as { message: string; code?: string } };
  const res = {
    status(s: number) {
      out.status = s;
      return this;
    },
    json(b: { message: string; code?: string }) {
      out.body = b;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new SignetErrorFilter(nullLogger).catch(exception, host);
  return out;
}

describe("errors, as the console shows them", () => {
  it("reads a typed error thrown bare, as two endpoints throw it", () => {
    const r = send({ kind: "recoverable", code: "ask.failed", message: "Claude Code is not signed in." });
    expect(r.body).toMatchObject({ code: "ask.failed", message: "Claude Code is not signed in." });
  });

  it("never shows [object Object] for something unexpected", () => {
    const r = send({ weird: true });
    expect(r.status).toBe(500);
    expect(r.body.message).not.toContain("[object Object]");
    expect(r.body.message).toContain("weird");
  });
});
