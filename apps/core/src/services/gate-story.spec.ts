// Reading the gate story out of the verdict history.
//
// A live run exposed two reporting lies at once. The conformance gate failed, the
// agent was handed the findings, and it passed on the next round — but the run
// summary said "repairs: 0" and listed conformance under failed gates. So a
// successful repair was reported as both invisible AND a failure.
//
// The cause: the repair loop re-runs the gate suite inside a single phase attempt,
// so RunPhase.attempt stays 1, and a naive "any verdict with outcome=fail" query
// cannot tell a blocker from something that was fixed. Both are derived from the
// verdict sequence instead, and pinned here.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../persistence/generated/client.js";
import { OperatorViews } from "./operator-views.js";

const url = process.env["SIGNET_DATABASE_URL"];
const enabled = typeof url === "string" && url.length > 0;
const d = enabled ? describe : describe.skip;

let db: PrismaClient;
let views: OperatorViews;
const made = { features: [] as string[], increments: [] as string[], runs: [] as string[] };

beforeAll(async () => {
  if (!enabled) return;
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  views = new OperatorViews(db, {
    quotaState: async () => ({ windowKind: "five_hour", exhausted: false, activeWorkers: 0 }),
    activeWorkers: () => 0,
    dispatcherState: () => ({ paused: false, maxWorkers: 2 }),
  });
});

afterAll(async () => {
  if (!enabled) return;
  // Clean up only what this spec created, children before parents.
  await db.gateVerdict.deleteMany({ where: { runId: { in: made.runs } } });
  await db.runPhase.deleteMany({ where: { runId: { in: made.runs } } });
  await db.run.deleteMany({ where: { id: { in: made.runs } } });
  await db.increment.deleteMany({ where: { id: { in: made.increments } } });
  await db.briefVersion.deleteMany({ where: { featureId: { in: made.features } } });
  await db.feature.deleteMany({ where: { id: { in: made.features } } });
  await db.$disconnect();
});

/** A run with a scripted verdict history: rounds of [gate, outcome] pairs. */
async function runWithVerdicts(
  title: string,
  rounds: readonly (readonly [string, string])[][],
): Promise<string> {
  const featureId = randomUUID();
  const briefId = randomUUID();
  const incId = randomUUID();
  const runId = randomUUID();
  made.features.push(featureId);
  made.increments.push(incId);
  made.runs.push(runId);

  await db.feature.create({ data: { id: featureId, title, stage: "IMPLEMENTING" } });
  await db.briefVersion.create({ data: { id: briefId, featureId, version: 1, contentMd: "brief" } });
  await db.increment.create({
    data: {
      id: incId,
      featureId,
      title,
      status: "AWAITING_SIGNATURE",
      stateJson: JSON.stringify({ status: "AWAITING_SIGNATURE" }),
      declaredSurface: ["a.mjs"],
      briefVersionId: briefId,
      orderIndex: 0,
    },
  });
  await db.run.create({
    data: {
      id: runId,
      incrementId: incId,
      status: "SUCCEEDED",
      stateJson: JSON.stringify({ status: "SUCCEEDED" }),
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(),
    },
  });

  // One RunPhase, attempt 1 — exactly what a repair inside a phase leaves behind.
  await db.runPhase.create({
    data: {
      id: randomUUID(),
      runId,
      phase: "GATES",
      attempt: 1,
      enteredAt: new Date(Date.now() - 30_000),
      completedAt: new Date(),
    },
  });

  let t = Date.now() - 20_000;
  for (const round of rounds) {
    for (const [gate, outcome] of round) {
      await db.gateVerdict.create({
        data: {
          id: randomUUID(),
          runId,
          gate,
          outcome,
          findingsJson: "[]",
          recordedAt: new Date(t),
        },
      });
      t += 50;
    }
    t += 5000; // the gap between rounds
  }
  return incId;
}

d("gate story (live DB)", () => {
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

    // The phase row says attempt 1, but two gate rounds ran — so one repair.
    expect(run.maxAttempt).toBe(1);
    expect(run.gateRounds).toBe(2);
    expect(run.repairs).toBe(1);

    // And conformance is reported as REPAIRED, not failed: it blocked, the agent
    // was given the findings, and the next round passed. That is the gate working.
    expect(run.gatesFailed).toEqual([]);
    expect(run.gatesRepaired).toEqual(["conformance"]);
  });

  it("reports a gate still failing in the last round as an actual blocker", async () => {
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
    expect(run?.repairs).toBe(1); // it was retried once and still failed
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

  it("distinguishes two gates where one was fixed and the other was not", async () => {
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
});
