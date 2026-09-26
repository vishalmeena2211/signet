// Reading the check story out of the verdict history.
//
// A live run exposed two reporting lies at once. The conformance check failed, the
// agent was handed the findings, and it passed on the next round — but the run
// summary said "repairs: 0" and listed conformance under failed checks. So a
// successful repair was reported as both invisible AND a failure.
//
// The cause: the repair loop re-runs the check suite inside a single phase attempt,
// so RunPhase.attempt stays 1, and a naive "any verdict with outcome=fail" query
// cannot tell a blocker from something that was fixed. Both are derived from the
// verdict sequence instead, and pinned here.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { RunIdSchema } from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";
import { setupTestDatabase, truncateAll } from "../testing/test-db.js";
import { seedFeature, seedRun } from "../testing/fixtures.js";
import { OperatorViews } from "./operator-views.js";

const ctx = await setupTestDatabase();
const d = ctx ? describe : describe.skip;

let db: PrismaClient;
let views: OperatorViews;

beforeAll(() => {
  if (!ctx) return;
  db = ctx.db;
  views = new OperatorViews(db, {
    quotaState: async () => ({ windowKind: "five_hour", exhausted: false, activeWorkers: 0 }),
    activeWorkers: () => 0,
    dispatcherState: () => ({ paused: false, maxWorkers: 2 }),
  });
});

afterAll(async () => {
  if (!ctx) return;
  // Unconditional and id-free: unlike deleting remembered rows, this cannot miss
  // anything, and it runs against a database the tests own.
  await truncateAll(ctx.db, ctx.url);
  await ctx.db.$disconnect();
});

/**
 * A run whose checks went through the given rounds. The state goes in as an
 * object, so an invalid one fails here rather than becoming an unreadable row.
 */
async function runWithVerdicts(title: string, rounds: (readonly [string, string])[][]): Promise<string> {
  const seeded = await seedFeature(db, {
    title,
    steps: [{ title, state: { status: "AWAITING_SIGNATURE", runId: RunIdSchema.parse(randomUUID()) } }],
  });
  const incrementId = seeded.incrementIds[0] as string;
  // One phase row at attempt 1 — exactly what a repair inside a phase leaves.
  await seedRun(db, {
    incrementId,
    phases: [{ phase: "GATES", attempt: 1, durationMs: 30_000 }],
    verdictRounds: rounds,
  });
  return incrementId;
}

d("check story (isolated database)", () => {
  it("counts a repair that happened inside one phase attempt", async () => {
    const incId = await runWithVerdicts("gs: repaired", [
      [
        ["conformance", "fail"],
        ["tests", "pass"],
        ["lint", "pass"],
      ],
      [
        ["conformance", "pass"],
        ["tests", "pass"],
        ["lint", "pass"],
      ],
    ]);

    const [run] = await views.runs({ incrementId: incId, limit: 1 });
    expect(run).toBeDefined();
    if (!run) return;

    // The phase row says attempt 1, but two rounds ran — so one repair.
    expect(run.maxAttempt).toBe(1);
    expect(run.gateRounds).toBe(2);
    expect(run.repairs).toBe(1);

    // And conformance is reported as REPAIRED, not failed: it blocked, the agent
    // was given the findings, and the next round passed. That is the check working.
    expect(run.gatesFailed).toEqual([]);
    expect(run.gatesRepaired).toEqual(["conformance"]);
  });

  it("reports a check still failing in the last round as an actual blocker", async () => {
    const incId = await runWithVerdicts("gs: blocked", [
      [
        ["conformance", "fail"],
        ["tests", "pass"],
      ],
      [
        ["conformance", "fail"],
        ["tests", "pass"],
      ],
    ]);

    const [run] = await views.runs({ incrementId: incId, limit: 1 });
    expect(run?.gatesFailed).toEqual(["conformance"]);
    expect(run?.gatesRepaired).toEqual([]);
    expect(run?.repairs).toBe(1); // retried once and still failed
  });

  it("calls a clean single-round run zero repairs", async () => {
    const incId = await runWithVerdicts("gs: clean", [
      [
        ["conformance", "pass"],
        ["tests", "pass"],
        ["lint", "pass"],
      ],
    ]);

    const [run] = await views.runs({ incrementId: incId, limit: 1 });
    expect(run?.gateRounds).toBe(1);
    expect(run?.repairs).toBe(0);
    expect(run?.gatesFailed).toEqual([]);
    expect(run?.gatesRepaired).toEqual([]);
  });

  it("distinguishes two checks where one was fixed and the other was not", async () => {
    const incId = await runWithVerdicts("gs: mixed", [
      [
        ["conformance", "fail"],
        ["tests", "fail"],
      ],
      [
        ["conformance", "pass"],
        ["tests", "fail"],
      ],
    ]);

    const [run] = await views.runs({ incrementId: incId, limit: 1 });
    expect(run?.gatesRepaired).toEqual(["conformance"]);
    expect(run?.gatesFailed).toEqual(["tests"]);
  });

  it("REFUSES an invalid state at the fixture, not at the database", async () => {
    // This is the bug that started all of this: AWAITING_SIGNATURE requires a
    // runId, and writing it without one produced a row the console could not
    // read. Going through the schema means the spec fails instead.
    await expect(
      seedFeature(db, {
        title: "invalid fixture",
        // @ts-expect-error -- deliberately missing runId, which is the point
        steps: [{ title: "bad", state: { status: "AWAITING_SIGNATURE" } }],
      }),
    ).rejects.toThrow(/runId/);
  });
});
