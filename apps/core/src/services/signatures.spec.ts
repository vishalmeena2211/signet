// The two signatures refuse before they act.
//
// The merge path matters most: it runs `git merge` into the base branch, which
// is not undoable from the console. The state guard used to run only after that
// merge, so an increment that was never reviewed could have its branch landed
// and only then be refused. These tests pin the order.

import { describe, expect, it } from "vitest";
import { IncrementIdSchema, type IncrementState, type IncrementStatus } from "@signet/contracts";
import { Signatures } from "./signatures.js";
import type { UnitOfWork } from "../domain/runtime/ports.js";

const INC = IncrementIdSchema.parse("11111111-aaaa-4bbb-8ccc-00000000ff01");

/** A unit of work that answers with one increment state and records writes. */
function fakeUow(status: IncrementStatus | null) {
  const transitions: string[] = [];
  const enqueued: string[] = [];
  const tx = {
    increments: {
      get: async () =>
        status === null ? null : { id: INC, state: { status } as IncrementState, declaredSurface: [], repairAttempt: 0, freshRestarts: 0 },
      transition: async (_id: unknown, from: string, to: IncrementState) => {
        transitions.push(`${from}->${to.status}`);
      },
    },
    runs: {
      create: async (r: { id: string }) => {
        enqueued.push(r.id);
      },
    },
    outbox: { enqueue: async () => {} },
  };
  const uow = { run: async (fn: (t: unknown) => unknown) => fn(tx) } as unknown as UnitOfWork;
  return { uow, transitions, enqueued };
}

/** A repo path that would fail loudly if git were ever invoked against it. */
const NOT_A_REPO = "/nonexistent/signet-should-never-touch-this";

describe("signatures", () => {
  it("merge refuses an increment that is not awaiting signature, WITHOUT running git", async () => {
    const { uow, transitions } = fakeUow("RUNNING");
    const sigs = new Signatures(uow, NOT_A_REPO, "main");

    await expect(sigs.merge(INC)).rejects.toMatchObject({
      signet: { kind: "conflict", code: "increment.illegal_transition" },
    });
    // The refusal is a state check, not a git failure: nothing was written and
    // the error is our typed conflict rather than an ENOENT from git.
    expect(transitions).toEqual([]);
  });

  it("merge refuses a missing increment as not_found", async () => {
    const { uow } = fakeUow(null);
    const sigs = new Signatures(uow, NOT_A_REPO, "main");
    await expect(sigs.merge(INC)).rejects.toMatchObject({
      signet: { kind: "non_recoverable", code: "increment.not_found" },
    });
  });

  it("approve refuses a missing increment before enqueueing a run", async () => {
    const { uow, enqueued } = fakeUow(null);
    const sigs = new Signatures(uow, NOT_A_REPO, "main");
    await expect(sigs.approve(INC)).rejects.toMatchObject({
      signet: { code: "increment.not_found" },
    });
    // Without the pre-check this reached the database as a foreign-key
    // violation, which surfaced to the console as an unreadable 500.
    expect(enqueued).toEqual([]);
  });
});
