// The automation guards, pinned.
//
// This is the only code in Signet that starts work with nobody watching, so its tests
// are almost entirely about what it REFUSES to do. A workflow engine that mostly works
// is worse than none: the failure mode is unattended spending, or a loop that creates
// features until a quota window dies.
//
// Four refusals matter:
//
//   · It never merges. Signature 2 stays human, always.
//   · It stops a cascade at a depth limit.
//   · It ignores events its own runs caused.
//   · It refuses a recipe with blanks, because unattended means nobody can fill them.
//
// And one thing it must always do: record WHY it did nothing. A skipped run that leaves
// no trace is indistinguishable from one that never fired.

import { describe, expect, it } from "vitest";
import { isDue, WorkflowEngine, type WorkflowDeps } from "./workflow-engine.js";
import { setupTestDatabase, truncateAll } from "../testing/test-db.js";
import { afterAll, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../persistence/generated/client.js";

const ctx = await setupTestDatabase("workflow");
const d = ctx ? describe : describe.skip;

let db: PrismaClient;
const silent = { info: () => {}, warn: () => {}, error: () => {}, child: () => silent } as never;

beforeAll(() => {
  if (ctx) db = ctx.db;
});
afterAll(async () => {
  if (!ctx) return;
  await truncateAll(ctx.db, ctx.url);
  await ctx.db.$disconnect();
});

/** Records every call so the test can assert what automation did and did not touch. */
function spyDeps(overrides: Partial<WorkflowDeps> = {}) {
  const calls = { proposed: 0, created: 0, approved: [] as string[] };
  const deps: WorkflowDeps = {
    db,
    log: silent,
    propose: async () => {
      calls.proposed += 1;
      return {
        ok: true as const,
        title: "Automated work",
        briefMd: "understanding",
        increments: [
          { title: "step one", declaredSurface: ["cart.mjs"], acceptanceMd: "done when x" },
          { title: "step two", declaredSurface: ["badge.mjs"], acceptanceMd: "done when y" },
        ],
      };
    },
    createFeature: async (input) => {
      calls.created += 1;
      const featureId = randomUUID();
      const briefId = randomUUID();
      await db.feature.create({ data: { id: featureId, title: input.title, stage: "IMPLEMENTING" } });
      await db.briefVersion.create({
        data: { id: briefId, featureId, version: 1, contentMd: input.briefMd },
      });
      let order = 0;
      for (const inc of input.increments) {
        await db.increment.create({
          data: {
            id: randomUUID(),
            featureId,
            title: inc.title,
            status: "CONTEXT_READY",
            stateJson: JSON.stringify({ status: "CONTEXT_READY" }),
            declaredSurface: inc.declaredSurface,
            acceptanceMd: inc.acceptanceMd,
            briefVersionId: briefId,
            orderIndex: order++,
          },
        });
      }
      return { featureId };
    },
    approve: async (incrementId) => {
      calls.approved.push(incrementId);
    },
    ...overrides,
  };
  return { deps, calls };
}

function makeEngine(deps: WorkflowDeps): WorkflowEngine {
  return new WorkflowEngine(deps);
}

/** A workflow with one runnable recipe. */
async function seedWorkflow(opts: {
  goalMd?: string;
  enabled?: boolean;
  maxDepth?: number;
  trigger?: unknown;
} = {}): Promise<string> {
  const recipeId = randomUUID();
  const workflowId = randomUUID();
  await db.recipe.create({
    data: {
      id: recipeId,
      name: "nightly tidy",
      goalMd: opts.goalMd ?? "Tidy up the cart module and add any missing tests for it.",
    },
  });
  await db.workflow.create({
    data: {
      id: workflowId,
      name: "nightly",
      enabled: opts.enabled ?? true,
      maxDepth: opts.maxDepth ?? 1,
      triggerJson: JSON.stringify(opts.trigger ?? { kind: "event", event: "step_merged" }),
    },
  });
  await db.workflowStep.create({ data: { id: randomUUID(), workflowId, recipeId, orderIndex: 0 } });
  return workflowId;
}

d("automation never merges", () => {
  it("approves only signature 1, and only for the first step", async () => {
    // The line the whole design rests on. Automation approves SPENDING; a human approves
    // CODE LANDING. And only the first step is started, so an unattended run cannot
    // quietly consume a whole quota window on one trigger.
    const workflowId = await seedWorkflow();
    const { deps, calls } = spyDeps();
    const engine = makeEngine(deps);

    const res = await engine.run(workflowId, { triggeredBy: "manual" });
    expect("runId" in res).toBe(true);

    expect(calls.created).toBe(1);
    // Two increments were created; exactly one was started.
    expect(calls.approved).toHaveLength(1);

    // Nothing reached MERGED. There is no code path here that could.
    const merged = await db.increment.count({ where: { status: "MERGED" } });
    expect(merged).toBe(0);
  });
});

d("the depth limit stops a cascade", () => {
  it("refuses a run deeper than the workflow allows, and says so", async () => {
    const workflowId = await seedWorkflow({ maxDepth: 1 });
    const { deps, calls } = spyDeps();
    const engine = makeEngine(deps);

    const res = await engine.run(workflowId, { triggeredBy: "event", depth: 2 });
    expect("skipped" in res).toBe(true);
    if (!("skipped" in res)) return;
    expect(res.reason).toMatch(/triggering itself/i);
    // Refused before spending anything.
    expect(calls.proposed).toBe(0);
  });

  it("allows a run at the limit, so the limit is not off by one", async () => {
    const workflowId = await seedWorkflow({ maxDepth: 1 });
    const { deps } = spyDeps();
    const res = await makeEngine(deps).run(workflowId, { triggeredBy: "event", depth: 1 });
    expect("runId" in res).toBe(true);
  });
});

d("it ignores events its own runs caused", () => {
  it("does not react to a run it started itself", async () => {
    // The tightest possible loop: a workflow listening for step_merged whose own work
    // merges. Closed before the depth counter is even consulted.
    const workflowId = await seedWorkflow({ trigger: { kind: "event", event: "step_merged" } });
    const { deps, calls } = spyDeps();
    const engine = makeEngine(deps);

    const first = await engine.run(workflowId, { triggeredBy: "manual" });
    expect("runId" in first).toBe(true);
    if (!("runId" in first)) return;
    const before = calls.proposed;

    await engine.onEvent("step_merged", { runId: first.runId });
    expect(calls.proposed).toBe(before);
  });

  it("does react to an event from somebody else's run", async () => {
    // The guard must not be so broad that the feature stops working.
    const workflowId = await seedWorkflow({ trigger: { kind: "event", event: "step_merged" } });
    const { deps, calls } = spyDeps();
    const engine = makeEngine(deps);
    await engine.onEvent("step_merged", { runId: randomUUID() });
    expect(calls.proposed).toBeGreaterThan(0);
    expect(workflowId).toBeTruthy();
  });
});

d("the kill switch", () => {
  it("stops unattended firing", async () => {
    const workflowId = await seedWorkflow();
    const { deps, calls } = spyDeps();
    const engine = makeEngine(deps);
    engine.setPaused(true);

    const res = await engine.run(workflowId, { triggeredBy: "schedule" });
    expect("skipped" in res).toBe(true);
    expect(calls.proposed).toBe(0);
  });

  it("still lets a human press the button", async () => {
    // The switch exists to stop things happening while you are not looking. A person
    // deliberately pressing run is not the thing being protected against.
    const workflowId = await seedWorkflow();
    const { deps, calls } = spyDeps();
    const engine = makeEngine(deps);
    engine.setPaused(true);

    const res = await engine.run(workflowId, { triggeredBy: "manual" });
    expect("runId" in res).toBe(true);
    expect(calls.proposed).toBe(1);
  });
});

d("a template cannot be automated", () => {
  it("refuses a recipe with blanks, because nobody is there to fill them", async () => {
    const workflowId = await seedWorkflow({
      goalMd: "Add a {{thing}} to the cart module, with tests covering the edge cases.",
    });
    const { deps, calls } = spyDeps();
    const res = await makeEngine(deps).run(workflowId, { triggeredBy: "schedule" });
    expect("skipped" in res).toBe(true);
    if (!("skipped" in res)) return;
    expect(res.reason).toContain("thing");
    // Refusing beats substituting something plausible.
    expect(calls.proposed).toBe(0);
  });
});

d("a switched-off workflow", () => {
  it("does not fire on a schedule or an event", async () => {
    const workflowId = await seedWorkflow({ enabled: false });
    const { deps, calls } = spyDeps();
    const res = await makeEngine(deps).run(workflowId, { triggeredBy: "schedule" });
    expect("skipped" in res).toBe(true);
    expect(calls.proposed).toBe(0);
  });
});

d("every refusal leaves a record", () => {
  it("writes a skipped run with its reason", async () => {
    // A skip that leaves no trace is indistinguishable from never having fired, which is
    // the worst state for something running while you are not watching.
    const workflowId = await seedWorkflow();
    const { deps } = spyDeps();
    const engine = makeEngine(deps);
    await engine.recordSkip(workflowId, "schedule", "Automation is paused.");

    const rows = await db.workflowRun.findMany({ where: { workflowId, status: "skipped" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcomeJson).toContain("Automation is paused.");
  });

  it("records a failing recipe as a failed run rather than losing it", async () => {
    const workflowId = await seedWorkflow();
    const { deps } = spyDeps({
      propose: async () => ({ ok: false as const, reason: "found no source files" }),
    });
    const res = await makeEngine(deps).run(workflowId, { triggeredBy: "manual" });
    expect("runId" in res).toBe(true);
    if (!("runId" in res)) return;
    const row = await db.workflowRun.findUniqueOrThrow({ where: { id: res.runId } });
    expect(row.status).toBe("failed");
    expect(row.outcomeJson).toContain("found no source files");
  });
});

// Pure arithmetic, so tested directly rather than through the engine.
describe("when a schedule is due", () => {
  const daily = { every: "day" as const, atHour: 9, atMinute: 0, onWeekday: 1 };

  it("fires once the window has opened", () => {
    const now = new Date("2026-09-26T09:30:00");
    expect(isDue(daily, null, now)).toBe(true);
  });

  it("does not fire twice in the same window", () => {
    const now = new Date("2026-09-26T09:30:00");
    const firedAt = new Date("2026-09-26T09:05:00");
    expect(isDue(daily, firedAt, now)).toBe(false);
  });

  it("fires again in the next window", () => {
    const now = new Date("2026-09-27T09:01:00");
    const firedAt = new Date("2026-09-26T09:05:00");
    expect(isDue(daily, firedAt, now)).toBe(true);
  });

  it("does NOT replay windows missed while the process was down", () => {
    // The failure being prevented: a machine asleep for two days waking up and firing
    // forty-eight backdated hourly runs. A schedule means "roughly now", and a burst of
    // catch-up work is never what anybody wanted.
    const hourly = { every: "hour" as const, atHour: 0, atMinute: 0, onWeekday: 1 };
    const now = new Date("2026-09-26T12:00:00");
    const firedAt = new Date("2026-09-24T12:00:00");
    // Due once — not once per missed hour.
    expect(isDue(hourly, firedAt, now)).toBe(true);
    const after = new Date("2026-09-26T12:00:00");
    expect(isDue(hourly, after, now)).toBe(false);
  });

  it("waits for the hour on a weekly schedule, not just the day", () => {
    const weekly = { every: "week" as const, atHour: 9, atMinute: 0, onWeekday: 1 };
    // Monday 08:00 — the day is right, the window has not opened.
    expect(isDue(weekly, new Date("2026-09-21T09:00:00"), new Date("2026-09-28T08:00:00"))).toBe(false);
    // Monday 09:30 — open.
    expect(isDue(weekly, new Date("2026-09-21T09:00:00"), new Date("2026-09-28T09:30:00"))).toBe(true);
  });
});

d("a recipe that finds nothing to do", () => {
  it("succeeds and says so, rather than reporting a failure", async () => {
    // Exactly what happened on the first real automated run, and the reason it read as
    // broken: a clean repo gave the correct answer and the engine called it a failure.
    const workflowId = await seedWorkflow();
    const { deps, calls } = spyDeps({
      propose: async () => ({
        ok: true as const,
        title: "Nothing to do",
        briefMd: "u",
        increments: [],
        noWorkNeeded: "Every module already has a sibling test file.",
      }),
    });
    const res = await makeEngine(deps).run(workflowId, { triggeredBy: "schedule" });
    expect("runId" in res).toBe(true);
    if (!("runId" in res)) return;

    const row = await db.workflowRun.findUniqueOrThrow({ where: { id: res.runId } });
    expect(row.status).toBe("succeeded");
    expect(row.outcomeJson).toContain("already has a sibling test");
    // And it created nothing: a feature with no steps is not a thing.
    expect(calls.created).toBe(0);
    expect(calls.approved).toEqual([]);
  });
});
