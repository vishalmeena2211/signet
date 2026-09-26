// Fixtures that cannot be invalid.
//
// A spec wrote an increment with `stateJson: JSON.stringify({ status:
// "AWAITING_SIGNATURE" })`. That state requires a runId, so the row was
// unreadable — and because the spec wrote straight to the database, nothing
// objected until the console tried to display it weeks later and returned
// 422 increment.corrupt_state.
//
// The lesson is not "be careful with fixtures". It is that a fixture which
// bypasses the schema is writing data the application can never read. Everything
// here goes through the contracts schema on the way in, so a bad fixture fails in
// the test that wrote it, loudly, at the line that wrote it.

import { randomUUID } from "node:crypto";
import { IncrementStateSchema, type IncrementState } from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";

/**
 * Serialises an increment state through the schema. Invalid input throws here —
 * in the spec, with a message naming the missing field — rather than becoming a
 * row nothing can read.
 */
export function stateJson(state: IncrementState): string {
  return JSON.stringify(IncrementStateSchema.parse(state));
}

export interface SeededFeature {
  featureId: string;
  briefVersionId: string;
  incrementIds: string[];
}

/**
 * A feature with its request and steps, written the way the application writes
 * them. Takes states as objects rather than strings so they cannot skip the
 * schema.
 */
export async function seedFeature(
  db: PrismaClient,
  opts: {
    title: string;
    briefMd?: string;
    steps: { title: string; state: IncrementState; declaredSurface?: string[] }[];
  },
): Promise<SeededFeature> {
  const featureId = randomUUID();
  const briefVersionId = randomUUID();

  await db.feature.create({ data: { id: featureId, title: opts.title, stage: "IMPLEMENTING" } });
  await db.briefVersion.create({
    data: {
      id: briefVersionId,
      featureId,
      version: 1,
      contentMd: opts.briefMd ?? `Request for ${opts.title}.`,
    },
  });

  const incrementIds: string[] = [];
  for (const [i, step] of opts.steps.entries()) {
    const id = randomUUID();
    incrementIds.push(id);
    await db.increment.create({
      data: {
        id,
        featureId,
        title: step.title,
        // The status column mirrors the state, so they cannot disagree.
        status: step.state.status,
        stateJson: stateJson(step.state),
        declaredSurface: step.declaredSurface ?? ["src/example.ts"],
        briefVersionId,
        orderIndex: i,
      },
    });
  }

  return { featureId, briefVersionId, incrementIds };
}

/** A run against a step, with the phases and verdicts a suite wants to assert on. */
export async function seedRun(
  db: PrismaClient,
  opts: {
    incrementId: string;
    status?: "SUCCEEDED" | "FAILED" | "ABORTED" | "PHASE";
    startedAt?: Date;
    finishedAt?: Date | null;
    phases?: { phase: string; attempt?: number; durationMs?: number }[];
    /** Rounds of the check suite, in order: [["conformance","fail"], …]. */
    verdictRounds?: (readonly [string, string])[][];
  },
): Promise<string> {
  const runId = randomUUID();
  const started = opts.startedAt ?? new Date(Date.now() - 60_000);
  const status = opts.status ?? "SUCCEEDED";

  await db.run.create({
    data: {
      id: runId,
      incrementId: opts.incrementId,
      status,
      stateJson: JSON.stringify({ status }),
      startedAt: started,
      finishedAt: opts.finishedAt === undefined ? new Date() : opts.finishedAt,
    },
  });

  let cursor = started.getTime();
  for (const p of opts.phases ?? []) {
    const entered = new Date(cursor);
    const ms = p.durationMs ?? 1000;
    cursor += ms;
    await db.runPhase.create({
      data: {
        id: randomUUID(),
        runId,
        phase: p.phase,
        attempt: p.attempt ?? 1,
        enteredAt: entered,
        completedAt: new Date(cursor),
      },
    });
  }

  let t = started.getTime();
  for (const round of opts.verdictRounds ?? []) {
    for (const [gate, outcome] of round) {
      await db.gateVerdict.create({
        data: { id: randomUUID(), runId, gate, outcome, findingsJson: "[]", recordedAt: new Date(t) },
      });
      t += 50;
    }
    t += 5000; // the gap between rounds, which is how rounds are told apart
  }

  return runId;
}
