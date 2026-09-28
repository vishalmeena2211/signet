// Sending work back, answering the fence, and what the seal holds on — against a real
// database, because each one is a state transition plus a new version of the request,
// and the value of both is that they are recorded.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../persistence/generated/client.js";
import { PrismaUnitOfWork } from "../persistence/prisma-ports.js";
import { setupTestDatabase, truncateAll } from "../testing/test-db.js";
import { Controls } from "./controls.js";
import { WorkViews } from "./work-views.js";
import { AgentWorkLog } from "./agent-work.js";
import { ConsoleViews } from "./console-views.js";

const ctx = await setupTestDatabase("judging");
const enabled = ctx !== null;
const d = enabled ? describe : describe.skip;

let db: PrismaClient;
let controls: Controls;
let work: WorkViews;

beforeAll(() => {
  if (!enabled) return;
  db = ctx!.db;
  controls = new Controls(db, new PrismaUnitOfWork(db), { abort: () => false });
  work = new WorkViews(db, new AgentWorkLog("/nonexistent"));
});
beforeEach(async () => {
  if (enabled) await truncateAll(db, ctx!.url);
});
afterAll(async () => {
  if (!enabled) return;
  await truncateAll(db, ctx!.url);
  await db.$disconnect();
});

async function seed(opts: { status: string; state: object; acceptanceMd?: string }) {
  const featureId = randomUUID();
  const briefId = randomUUID();
  const incId = randomUUID();
  await db.feature.create({ data: { id: featureId, title: "Cluster markers", stage: "IMPLEMENTING" } });
  await db.briefVersion.create({ data: { id: briefId, featureId, version: 1, contentMd: "Cluster markers at low zoom." } });
  await db.increment.create({
    data: {
      id: incId,
      featureId,
      title: "Use it in the map layer",
      status: opts.status,
      stateJson: JSON.stringify(opts.state),
      declaredSurface: ["src/layer.ts", "src/layer.test.ts"],
      acceptanceMd: opts.acceptanceMd ?? "- Clusters above 40\n- A cluster of one is a marker",
      briefVersionId: briefId,
      orderIndex: 0,
    },
  });
  return { featureId, briefId, incId };
}

d("send it back with notes (live DB)", () => {
  it("writes the notes into a new version of the request and starts a new run", async () => {
    const oldRun = randomUUID();
    const { incId, featureId } = await seed({ status: "AWAITING_SIGNATURE", state: { status: "AWAITING_SIGNATURE", runId: oldRun } });
    await db.run.create({ data: { id: oldRun, incrementId: incId, status: "SUCCEEDED", stateJson: '{"status":"SUCCEEDED"}' } });

    const { runId } = await controls.sendBack(incId, [
      { file: "src/layer.ts", line: 45, text: "Use pxToMeters() from src/spatial.ts — this ignores latitude." },
      { file: null, line: null, text: "Add a test for an empty marker list." },
    ]);

    const inc = await db.increment.findUniqueOrThrow({ where: { id: incId } });
    expect(JSON.parse(inc.stateJson)).toEqual({ status: "RUNNING", runId });
    const brief = await db.briefVersion.findUniqueOrThrow({ where: { id: inc.briefVersionId } });
    expect(brief.version).toBe(2);
    expect(brief.contentMd).toContain("Cluster markers at low zoom.");
    expect(brief.contentMd).toContain("- src/layer.ts:45 — Use pxToMeters()");
    expect(brief.contentMd).toContain("- Add a test for an empty marker list.");
    // The earlier version is kept, not edited.
    expect(await db.briefVersion.count({ where: { featureId } })).toBe(2);
    expect(await db.outboxMessage.count({ where: { topic: "run.dispatch" } })).toBe(1);
  });

  it("refuses a step that is not waiting for the seal, and changes nothing", async () => {
    const { incId, featureId } = await seed({ status: "RUNNING", state: { status: "RUNNING", runId: randomUUID() } });
    await expect(controls.sendBack(incId, [{ file: null, line: null, text: "x" }])).rejects.toMatchObject({
      signet: { code: "increment.illegal_transition" },
    });
    expect(await db.briefVersion.count({ where: { featureId } })).toBe(1);
  });
});

d("answering the fence (live DB)", () => {
  async function fenceQuestion() {
    const s = await seed({ status: "ESCALATED", state: { status: "ESCALATED", escalationId: randomUUID() } });
    const escId = randomUUID();
    await db.increment.update({
      where: { id: s.incId },
      data: { stateJson: JSON.stringify({ status: "ESCALATED", escalationId: escId }) },
    });
    await db.escalation.create({
      data: {
        id: escId,
        incrementId: s.incId,
        status: "RAISED",
        stateJson: JSON.stringify({
          status: "RAISED",
          question: "It wants to change src/tiles.ts.",
          fence: { outside: ["src/tiles.ts"], reason: "Edge markers double-count.", surface: ["src/layer.ts", "src/layer.test.ts"] },
        }),
      },
    });
    return { ...s, escId };
  }

  it("shows the fence on the open question", async () => {
    const s = await fenceQuestion();
    const [q] = await new ConsoleViews(db).openEscalations(s.featureId);
    expect(q?.fence).toEqual({ outside: ["src/tiles.ts"], reason: "Edge markers double-count.", surface: ["src/layer.ts", "src/layer.test.ts"] });
  });

  it("widen: the files join the fence and the step is ready to start at once", async () => {
    const s = await fenceQuestion();
    const res = await controls.answerFence(s.escId, { choice: "widen" });
    expect(res.startNow).toBe(s.incId);
    const inc = await db.increment.findUniqueOrThrow({ where: { id: s.incId } });
    expect(inc.declaredSurface).toEqual(["src/layer.ts", "src/layer.test.ts", "src/tiles.ts"]);
    expect(inc.status).toBe("CONTEXT_READY");
    const brief = await db.briefVersion.findUniqueOrThrow({ where: { id: inc.briefVersionId } });
    expect(brief.contentMd).toContain("src/tiles.ts may be changed in this step");
  });

  it("stay: the fence is unchanged and the agent is told to manage without", async () => {
    const s = await fenceQuestion();
    await controls.answerFence(s.escId, { choice: "stay" });
    const inc = await db.increment.findUniqueOrThrow({ where: { id: s.incId } });
    expect(inc.declaredSurface).toEqual(["src/layer.ts", "src/layer.test.ts"]);
    const brief = await db.briefVersion.findUniqueOrThrow({ where: { id: inc.briefVersionId } });
    expect(brief.contentMd).toContain("Do not change src/tiles.ts");
  });

  it("split: a new step for those files goes BEFORE this one, and nothing starts by itself", async () => {
    const s = await fenceQuestion();
    const res = await controls.answerFence(s.escId, { choice: "split" });
    expect(res.startNow).toBeNull();
    const steps = await db.increment.findMany({ where: { featureId: s.featureId }, orderBy: { orderIndex: "asc" } });
    expect(steps.map((x) => [x.title, x.orderIndex, x.status])).toEqual([
      ["Change tiles.ts for “Use it in the map layer”", 0, "CONTEXT_READY"],
      ["Use it in the map layer", 1, "CONTEXT_READY"],
    ]);
    expect(steps[0]?.declaredSurface).toEqual(["src/tiles.ts"]);
    expect(steps[0]?.acceptanceMd).toBe("- Edge markers double-count.");
  });

  it("refuses to answer a plain question as if it were about the fence", async () => {
    const s = await seed({ status: "ESCALATED", state: { status: "ESCALATED", escalationId: randomUUID() } });
    const escId = randomUUID();
    await db.escalation.create({
      data: { id: escId, incrementId: s.incId, status: "RAISED", stateJson: JSON.stringify({ status: "RAISED", question: "Retry or skip?" }) },
    });
    await expect(controls.answerFence(escId, { choice: "widen" })).rejects.toMatchObject({ signet: { code: "escalation.not_fence" } });
  });
});

d("promises as the seal sees them (live DB)", () => {
  it("lists promises as not checked for a run from before promises were checked — and holds nothing", async () => {
    const runId = randomUUID();
    const { incId } = await seed({ status: "AWAITING_SIGNATURE", state: { status: "AWAITING_SIGNATURE", runId } });
    await db.run.create({ data: { id: runId, incrementId: incId, status: "SUCCEEDED", stateJson: '{"status":"SUCCEEDED"}' } });
    const view = await work.promises(incId);
    expect(view.checked).toBe(false);
    expect(view.promises.map((p) => p.promise)).toEqual(["Clusters above 40", "A cluster of one is a marker"]);
    expect(await work.unproven(incId)).toEqual([]);
  });

  it("reads the latest run's check, and the seal holds on exactly the unproven ones", async () => {
    const runId = randomUUID();
    const { incId } = await seed({ status: "AWAITING_SIGNATURE", state: { status: "AWAITING_SIGNATURE", runId } });
    await db.run.create({ data: { id: runId, incrementId: incId, status: "SUCCEEDED", stateJson: '{"status":"SUCCEEDED"}' } });
    await db.gateVerdict.create({
      data: {
        id: randomUUID(),
        runId,
        gate: "promises",
        outcome: "warn",
        findingsJson: JSON.stringify([
          { dimension: "proven", message: "Clusters above 40", location: "test “groups”", proof: { test: "groups", testFile: "src/layer.test.ts", codeFile: "src/layer.ts", codeLines: "41–44" } },
          { dimension: "unproven", message: "A cluster of one is a marker", location: "No test proves this.", proof: { test: null, testFile: null, codeFile: null, codeLines: null } },
        ]),
      },
    });
    const view = await work.promises(incId);
    expect(view.checked).toBe(true);
    expect(view.promises[0]).toMatchObject({ proven: true, test: "groups", codeLines: "41–44" });
    expect(view.promises[1]).toMatchObject({ proven: false, reason: "No test proves this." });
    expect(await work.unproven(incId)).toEqual(["A cluster of one is a marker"]);
  });
});
