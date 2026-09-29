// The backend the redesigned console needs, pinned.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrismaClient } from "../persistence/generated/client.js";
import { setupTestDatabase, truncateAll } from "../testing/test-db.js";
import { parseAgentQuestion } from "../domain/adapter/agent-question.js";
import { plainQuestion } from "../domain/runtime/run-machine.js";
import { nearestPath } from "./feature-proposer.js";
import { glance, portrait, RepoNotes } from "./portrait.js";
import { TakeBack } from "./take-back.js";
import { PlaceViews, StepViews } from "./place-views.js";
import { WorkViews } from "./work-views.js";
import { AgentWorkLog } from "./agent-work.js";
import { DiffReader } from "./diff-reader.js";
import { FeatureEvents, ProposalsInFlight } from "./feature-events.js";
import { Controls } from "./controls.js";
import { AutomationStore } from "./automation-store.js";
import { PrismaUnitOfWork } from "../persistence/prisma-ports.js";

const exec = promisify(execFile);

describe("the agent may stop and ask", () => {
  it("reads the last fenced ask, with its choices and its reason", () => {
    const reply = 'Found the tile loader.\n```json\n{"ask":{"question":"Retry an empty tile, or skip it?","options":["Skip it","Retry twice, then skip"],"why":"Both pass every check."}}\n```';
    expect(parseAgentQuestion(reply)).toEqual({ question: "Retry an empty tile, or skip it?", options: ["Skip it", "Retry twice, then skip"], why: "Both pass every check." });
  });
  it("finds nothing in an ordinary reply, or in a proofs block", () => {
    expect(parseAgentQuestion("Done.")).toBeNull();
    expect(parseAgentQuestion('```json\n{"proofs":[]}\n```')).toBeNull();
  });
});

describe("old questions read in plain words", () => {
  it("rewrites the stored repair-budget wording, and leaves others alone", () => {
    expect(plainQuestion("Increment exhausted its repair budget (3 repairs, 1 restart). Last failure: tests failed")).toBe(
      "It tried 3 repairs and a fresh start, and the checks still fail: tests failed. How should it go on?",
    );
    expect(plainQuestion("Should it retry?")).toBe("Should it retry?");
  });
});

describe("the one-click fix for a fence that matches nothing", () => {
  it("offers the nearest real file, a source before a test", () => {
    expect(nearestPath("src/clustering/**", ["src/cluster.test.ts", "src/cluster.ts", "src/layer.ts"])).toBe("src/cluster.ts");
  });
  it("offers nothing rather than a guess", () => {
    expect(nearestPath("src/zebra/**", ["src/cluster.ts"])).toBeNull();
  });
});

describe("the first-run portrait", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "signet-portrait-"));
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "x", main: "src/a.js", scripts: { test: "vitest run" }, devDependencies: { vitest: "1", tsup: "1" } }));
    await writeFile(join(repo, "pnpm-lock.yaml"), "");
    await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(repo, "src", "a.test.ts"), "test('a', () => {});\n");
    await writeFile(join(repo, "src", "b.ts"), "export const b = 2;\n".repeat(20));
    const git = (...a: string[]) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
    await git("init", "-q", "-b", "main");
    await git("add", "-A");
    await git("commit", "-qm", "first");
  });
  afterAll(async () => rm(repo, { recursive: true, force: true }));

  it("reads facts from files, marks a guess as unsure, and asks about it", async () => {
    const p = await portrait({ id: repo, label: "x", path: repo }, new RepoNotes(join(repo, "notes.json")));
    const text = p.pieces.map((x) => x.text).join("");
    expect(text).toContain("TypeScript library of");
    expect(text).toContain("installed with pnpm");
    expect(text).toContain("vitest");
    expect(p.pieces.find((x) => x.unsure)?.text).toBe("tsup, run directly");
    expect(p.doubt?.question).toBe("How is it built?");
    expect(p.asks[0]).toBe("Cover src/b.ts — the only module without a test");
  });

  it("keeps the answer with the repo, and stops asking", async () => {
    const notes = new RepoNotes(join(repo, "notes.json"));
    await notes.set(repo, "tsup");
    const p = await portrait({ id: repo, label: "x", path: repo }, notes);
    expect(p.doubt).toBeNull();
    expect(p.pieces.map((x) => x.text).join("")).toContain("You told me: tsup");
  });

  it("glances at a repo for the list", async () => {
    expect(await glance(repo)).toMatchObject({ branch: "main", tests: true });
  });
});

// ── against the database ──

const ctx = await setupTestDatabase("wireframe");
const d = ctx ? describe : describe.skip;
let db: PrismaClient;

// A take-back builds a real revert in a real worktree; under a loaded machine that passes 5s.
d("take it back, and the places (live DB)", { timeout: 20_000 }, () => {
  let root: string;
  let repo: string;
  let workspaces: string;
  const git = (...a: string[]) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });

  beforeAll(() => {
    db = ctx!.db;
  });
  beforeEach(async () => {
    await truncateAll(db, ctx!.url);
    root = await mkdtemp(join(tmpdir(), "signet-takeback-"));
    repo = join(root, "repo");
    workspaces = join(root, "ws");
    await mkdir(repo);
    await git("init", "-q", "-b", "main");
    await writeFile(join(repo, "a.txt"), "one\n");
    await git("add", "-A");
    await git("commit", "-qm", "first");
  });
  afterAll(async () => {
    if (!ctx) return;
    await truncateAll(db, ctx.url);
    await db.$disconnect();
  });

  /** A feature with one step, merged into the repo the way the seal merges. */
  async function sealedStep() {
    const featureId = randomUUID();
    const briefId = randomUUID();
    const incId = randomUUID();
    await git("checkout", "-qb", `signet/inc-${incId}`);
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    await git("commit", "-qam", "work");
    await git("checkout", "-q", "main");
    await git("merge", "--no-ff", "-m", `signet: merge increment ${incId}`, `signet/inc-${incId}`);
    await db.feature.create({ data: { id: featureId, title: "Numbers", stage: "IMPLEMENTING", repoPath: repo, repoLabel: "repo" } });
    await db.briefVersion.create({ data: { id: briefId, featureId, version: 1, contentMd: "Add two." } });
    await db.increment.create({
      data: {
        id: incId,
        featureId,
        title: "Add two",
        status: "MERGED",
        stateJson: JSON.stringify({ status: "MERGED", mergedAt: new Date().toISOString() }),
        declaredSurface: ["a.txt"],
        briefVersionId: briefId,
        orderIndex: 0,
      },
    });
    return { featureId, incId };
  }

  it("takes a step back as a revert waiting for the seal, and history is kept", async () => {
    const { incId } = await sealedStep();
    const res = await new TakeBack({ db, workspacesRoot: workspaces, configuredRepoPath: repo, baseRef: "main" }).start(incId);
    const back = await db.increment.findUniqueOrThrow({ where: { id: res.incrementId } });
    expect(back.status).toBe("AWAITING_SIGNATURE");
    expect(back.revertsIncrementId).toBe(incId);
    expect(back.title).toBe("Take back “Add two”");
    const { stdout } = await exec("git", ["log", "-1", "--format=%s", `signet/inc-${res.incrementId}`], { cwd: repo });
    expect(stdout).toContain("Revert");
    // Main itself is untouched until the revert is sealed.
    const { stdout: main } = await exec("git", ["show", "main:a.txt"], { cwd: repo });
    expect(main).toBe("one\ntwo\n");
  });

  it("refuses to take back a step twice", async () => {
    const { incId } = await sealedStep();
    const tb = new TakeBack({ db, workspacesRoot: workspaces, configuredRepoPath: repo, baseRef: "main" });
    await tb.start(incId);
    await expect(tb.start(incId)).rejects.toMatchObject({ signet: { code: "take_back.already" } });
  });

  it("dismisses a failure off the Desk, keeps it in the thread, and a retry brings it back", async () => {
    const featureId = randomUUID();
    const briefId = randomUUID();
    const incId = randomUUID();
    await db.feature.create({ data: { id: featureId, title: "Numbers", stage: "IMPLEMENTING", repoPath: repo, repoLabel: "repo" } });
    await db.briefVersion.create({ data: { id: briefId, featureId, version: 1, contentMd: "Add two." } });
    await db.increment.create({
      data: {
        id: incId,
        featureId,
        title: "Add two",
        status: "FAILED",
        stateJson: JSON.stringify({ status: "FAILED", reason: "aborted by user" }),
        declaredSurface: ["a.txt"],
        briefVersionId: briefId,
        orderIndex: 0,
      },
    });
    const views = new PlaceViews({
      db,
      diffs: new DiffReader(workspaces, "main"),
      work: new WorkViews(db, new AgentWorkLog(join(root, "packs"))),
      log: new AgentWorkLog(join(root, "packs")),
      proposals: new ProposalsInFlight(),
      quota: async () => ({ exhausted: false, windowKind: "five_hour" }),
      configuredRepoLabel: "repo",
      configuredRepoPath: repo,
      baseRef: "main",
    });
    const controls = new Controls(db, new PrismaUnitOfWork(db), { abort: () => false });
    controls.events = new FeatureEvents(db);

    expect((await views.desk()).decisions.map((x) => x.kind)).toEqual(["failed"]);
    expect((await views.thread(featureId)).steps[0]).toMatchObject({ dismissable: true, yours: true });

    await controls.dismiss(incId);
    expect((await views.desk()).decisions).toEqual([]);
    const thread = await views.thread(featureId);
    expect(thread.steps[0]).toMatchObject({ status: "FAILED", said: "failed · dismissed", yours: false, dismissable: false });
    expect(thread.events.map((e) => e.title)).toContain("You dismissed step 1");
    // Dismissing twice is not an error; dismissing anything but a failure is.
    await controls.dismiss(incId);

    await controls.retry(incId);
    const back = await db.increment.findUniqueOrThrow({ where: { id: incId } });
    expect(back.stateJson).not.toContain("dismissedAt");
    expect((await views.desk()).decisions.map((x) => x.kind)).toEqual(["initial"]);
    await expect(controls.dismiss(incId)).rejects.toThrow("only a failed step can be dismissed");
  });

  it("counts 'the suite passes' as proven at the seal only when the tests check passed", async () => {
    const featureId = randomUUID();
    const briefId = randomUUID();
    const incId = randomUUID();
    const runId = randomUUID();
    await db.feature.create({ data: { id: featureId, title: "Cart", stage: "IMPLEMENTING", repoPath: repo, repoLabel: "repo" } });
    await db.briefVersion.create({ data: { id: briefId, featureId, version: 1, contentMd: "Count items." } });
    await db.increment.create({
      data: {
        id: incId,
        featureId,
        title: "Add itemCount",
        status: "AWAITING_SIGNATURE",
        stateJson: JSON.stringify({ status: "AWAITING_SIGNATURE", runId }),
        declaredSurface: ["cart.mjs"],
        briefVersionId: briefId,
        orderIndex: 0,
      },
    });
    await db.run.create({ data: { id: runId, incrementId: incId, status: "SUCCEEDED", stateJson: JSON.stringify({ status: "SUCCEEDED" }) } });
    // What the promises check stored for the real run that forced a seal on trust.
    await db.gateVerdict.create({
      data: {
        id: randomUUID(),
        runId,
        gate: "promises",
        outcome: "warn",
        findingsJson: JSON.stringify([
          { dimension: "proven", message: "itemCount([]) returns 0", proof: { test: "empty", testFile: "cart.test.mjs", codeFile: null, codeLines: null } },
          { dimension: "unproven", message: "npm test exits with code 0, and cart.test.mjs reports ok", location: "No test proves this." },
          {
            dimension: "unproven",
            message: "total() still sums prices",
            location: "An existing test this change did not touch.",
            proof: { test: "total sums prices", testFile: "cart.test.mjs", codeFile: null, codeLines: null, existingTest: true },
          },
        ]),
      },
    });
    const tests = await db.gateVerdict.create({ data: { id: randomUUID(), runId, gate: "tests", outcome: "pass", findingsJson: "[]" } });
    const work = new WorkViews(db, new AgentWorkLog(join(root, "packs")));

    const view = await work.promises(incId);
    expect(view.promises.map((p) => p.proven)).toEqual([true, true, true]);
    expect(view.promises[1]).toMatchObject({ bySuite: true });
    expect(view.promises[2]).toMatchObject({ existingTest: true, test: "total sums prices" });
    expect(await work.unproven(incId)).toEqual([]);

    // A tests check that found nothing to run proves nothing about the suite.
    await db.gateVerdict.update({ where: { id: tests.id }, data: { outcome: "skipped" } });
    expect(await work.unproven(incId)).toEqual(["npm test exits with code 0, and cart.test.mjs reports ok", "total() still sums prices"]);
  });

  it("tells each round of checks apart, though every round shares one phase row", async () => {
    const featureId = randomUUID();
    const briefId = randomUUID();
    const incId = randomUUID();
    const runId = randomUUID();
    const t = (s: number) => new Date(Date.UTC(2026, 8, 28, 12, 21, s));
    await db.feature.create({ data: { id: featureId, title: "Badge tones", stage: "IMPLEMENTING", repoPath: repo, repoLabel: "repo" } });
    await db.briefVersion.create({ data: { id: briefId, featureId, version: 1, contentMd: "Tones." } });
    await db.increment.create({
      data: {
        id: incId,
        featureId,
        title: "Support tones",
        status: "AWAITING_SIGNATURE",
        stateJson: JSON.stringify({ status: "AWAITING_SIGNATURE", runId }),
        declaredSurface: ["badge.mjs"],
        briefVersionId: briefId,
        repairAttempt: 2,
        orderIndex: 0,
      },
    });
    await db.run.create({ data: { id: runId, incrementId: incId, status: "SUCCEEDED", stateJson: JSON.stringify({ status: "SUCCEEDED" }), startedAt: t(0), finishedAt: t(50) } });
    // What a real run left: ONE gates row for all three rounds, the first implement row
    // overwritten by the first repair.
    await db.runPhase.createMany({
      data: [
        { id: randomUUID(), runId, phase: "AGENT_IMPLEMENT", attempt: 1, enteredAt: t(1), completedAt: t(25) },
        { id: randomUUID(), runId, phase: "GATES", attempt: 1, enteredAt: t(10), completedAt: t(48) },
        { id: randomUUID(), runId, phase: "AGENT_IMPLEMENT", attempt: 2, enteredAt: t(27), completedAt: t(46) },
      ],
    });
    const fail = JSON.stringify([{ dimension: "fail_then_pass", message: "new tests PASS on the unchanged base code" }]);
    const round = (s: number, tests: "fail" | "pass") => [
      { id: randomUUID(), runId, gate: "lint", outcome: "pass", findingsJson: "[]", recordedAt: t(s) },
      { id: randomUUID(), runId, gate: "tests", outcome: tests, findingsJson: tests === "fail" ? fail : "[]", recordedAt: t(s) },
    ];
    await db.gateVerdict.createMany({ data: [...round(10, "fail"), ...round(26, "fail"), ...round(47, "pass")] });

    const thread = await new PlaceViews({
      db,
      diffs: new DiffReader(workspaces, "main"),
      work: new WorkViews(db, new AgentWorkLog(join(root, "packs"))),
      log: new AgentWorkLog(join(root, "packs")),
      proposals: new ProposalsInFlight(),
      quota: async () => ({ exhausted: false, windowKind: "five_hour" }),
      configuredRepoLabel: "repo",
      configuredRepoPath: repo,
      baseRef: "main",
    }).thread(featureId);
    const titles = thread.events.map((e) => e.title);
    expect(titles.filter((x) => x === "Tests failed · 1 finding")).toHaveLength(2);
    expect(titles.filter((x) => x.startsWith("Sent back to the agent"))).toHaveLength(2);
    expect(titles).toContain("Checks passed");
    expect(thread.events.find((e) => e.title.startsWith("Step 1 built"))?.detail).toBe("Checks sent it back twice; fixed.");
    // The code was written before the first round of checks, not after the first repair.
    expect(titles.indexOf("Step 1 · wrote the code")).toBeLessThan(titles.indexOf("Tests failed · 1 finding"));
  });

  it("sends a step back as one repair, and shows the note against what the rebuild changed", async () => {
    const featureId = randomUUID();
    const briefId = randomUUID();
    const incId = randomUUID();
    // The step's own copy of the repo, as a worktree would be: main, then the step's work.
    const ws = join(workspaces, `inc-${incId}`);
    await mkdir(ws, { recursive: true });
    const wgit = (...a: string[]) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: ws });
    await wgit("init", "-q", "-b", "main");
    await writeFile(join(ws, "cart.mjs"), "export const total = (xs) => xs.length;\n");
    await wgit("add", "-A");
    await wgit("commit", "-qm", "base");
    await wgit("checkout", "-qb", `signet/inc-${incId}`);
    await writeFile(join(ws, "cart.test.mjs"), "// one test\n");
    await wgit("add", "-A");
    await wgit("commit", "-qm", "work");

    await db.feature.create({ data: { id: featureId, title: "Totals", stage: "IMPLEMENTING", repoPath: repo, repoLabel: "repo" } });
    await db.briefVersion.create({ data: { id: briefId, featureId, version: 1, contentMd: "Format the total." } });
    const runId = randomUUID();
    await db.increment.create({
      data: {
        id: incId,
        featureId,
        title: "Add formatTotal",
        status: "AWAITING_SIGNATURE",
        stateJson: JSON.stringify({ status: "AWAITING_SIGNATURE", runId }),
        declaredSurface: ["cart.mjs", "cart.test.mjs"],
        briefVersionId: briefId,
        orderIndex: 0,
      },
    });
    await db.run.create({ data: { id: runId, incrementId: incId, status: "SUCCEEDED", stateJson: JSON.stringify({ status: "SUCCEEDED" }), startedAt: new Date(Date.now() - 60_000) } });

    const diffs = new DiffReader(workspaces, "main");
    const controls = new Controls(db, new PrismaUnitOfWork(db), { abort: () => false });
    controls.events = new FeatureEvents(db);
    controls.diffs = diffs;
    const note = { file: "cart.mjs", line: 1, text: "Nothing tests a negative total." };
    const { runId: rebuild } = await controls.sendBack(incId, [note]);

    // One repair spent, and the rebuild starts at writing: the plan still stands.
    expect((await db.increment.findUniqueOrThrow({ where: { id: incId } })).repairAttempt).toBe(1);
    const msg = await db.outboxMessage.findFirstOrThrow({ where: { payloadJson: { contains: rebuild } } });
    expect(JSON.parse(msg.payloadJson)).toMatchObject({ startPhase: "AGENT_IMPLEMENT", attempt: 1 });

    // The rebuild writes two lines, and comes back for the seal.
    await writeFile(join(ws, "cart.test.mjs"), "// one test\nif (f(-1) !== '-1') throw new Error('negative');\nif (f(0) !== '0') throw new Error('zero');\n");
    await wgit("commit", "-qam", "rebuild");
    await db.run.update({ where: { id: rebuild }, data: { status: "SUCCEEDED", finishedAt: new Date() } });
    await db.increment.update({ where: { id: incId }, data: { status: "AWAITING_SIGNATURE", stateJson: JSON.stringify({ status: "AWAITING_SIGNATURE", runId: rebuild }) } });

    const views = {
      db,
      diffs,
      work: new WorkViews(db, new AgentWorkLog(join(root, "packs"))),
      log: new AgentWorkLog(join(root, "packs")),
      proposals: new ProposalsInFlight(),
      quota: async () => ({ exhausted: false, windowKind: "five_hour" }),
      configuredRepoLabel: "repo",
      configuredRepoPath: repo,
      baseRef: "main",
    };
    const sheet = await new StepViews(views).sheet(incId);
    expect(sheet.repairs).toBe(1);
    expect(sheet.heard?.notes).toEqual([note]);
    expect(sheet.heard?.changed).toEqual([{ file: "cart.test.mjs", from: 2, to: 3 }]);
    const thread = await new PlaceViews(views).thread(featureId);
    expect(thread.events.map((e) => e.title)).toContain("Step 1 rebuilt from your note · Add formatTotal");

    // With the budget spent, it says so instead of sending back again.
    await db.increment.update({ where: { id: incId }, data: { repairAttempt: 3 } });
    await expect(controls.sendBack(incId, [note])).rejects.toMatchObject({ signet: { code: "send_back.no_repairs" } });
  });

  it("draws a routine's firings with what each recipe did, and puts a stopped routine on the Desk", async () => {
    const recipeA = randomUUID();
    const recipeB = randomUUID();
    const wfId = randomUUID();
    const stepA = randomUUID();
    const stepB = randomUUID();
    await db.recipe.createMany({
      data: [
        { id: recipeA, name: "Cover an untested module", goalMd: "Find one module with no test file and add one." },
        { id: recipeB, name: "Tidy what lint flags", goalMd: "Fix what the linter reports, without changing behaviour." },
      ],
    });
    await db.workflow.create({ data: { id: wfId, name: "Nightly coverage", enabled: true, triggerJson: JSON.stringify({ kind: "manual" }) } });
    await db.workflowStep.createMany({
      data: [
        { id: stepA, workflowId: wfId, recipeId: recipeA, orderIndex: 0 },
        { id: stepB, workflowId: wfId, recipeId: recipeB, orderIndex: 1 },
      ],
    });
    // The work the first recipe started: a feature whose first step waits at the seal.
    const featureId = randomUUID();
    const briefId = randomUUID();
    const incId = randomUUID();
    const runId = randomUUID();
    await db.feature.create({ data: { id: featureId, title: "Cover src/tiles.ts", stage: "IMPLEMENTING" } });
    await db.briefVersion.create({ data: { id: briefId, featureId, version: 1, contentMd: "Cover it." } });
    await db.increment.create({
      data: { id: incId, featureId, title: "Test tiles", status: "AWAITING_SIGNATURE", stateJson: JSON.stringify({ status: "AWAITING_SIGNATURE", runId }), declaredSurface: [], briefVersionId: briefId, orderIndex: 0 },
    });
    await db.run.create({ data: { id: runId, incrementId: incId, status: "SUCCEEDED", stateJson: JSON.stringify({ status: "SUCCEEDED" }) } });
    await db.usageLedgerEntry.create({ data: { id: randomUUID(), runId, model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.38 } });

    const lastNight = randomUUID();
    const tonight = randomUUID();
    await db.workflowRun.create({
      data: {
        id: lastNight,
        workflowId: wfId,
        triggeredBy: "schedule",
        status: "succeeded",
        startedAt: new Date(Date.now() - 86_400_000),
        finishedAt: new Date(Date.now() - 86_400_000 + 240_000),
        outcomeJson: JSON.stringify({
          outcomes: [
            { recipeName: "Cover an untested module", stepId: stepA, featureId, stepsQueued: 1, error: null, nothingNeeded: null },
            { recipeName: "Tidy what lint flags", stepId: stepB, featureId: null, stepsQueued: 0, error: null, nothingNeeded: "Lint reports no warnings." },
          ],
        }),
      },
    });
    await db.workflowRun.create({
      data: {
        id: tonight,
        workflowId: wfId,
        triggeredBy: "schedule",
        status: "failed",
        finishedAt: new Date(),
        outcomeJson: JSON.stringify({ outcomes: [{ recipeName: "Cover an untested module", stepId: stepA, featureId: null, stepsQueued: 0, error: "the repo could not be read", nothingNeeded: null }] }),
      },
    });

    const store = new AutomationStore({ db } as never);
    const [latest, previous] = await store.firings(wfId);
    expect(latest).toMatchObject({ id: tonight, status: "failed", steps: [{ stepId: stepA, error: "the repo could not be read", yours: false }] });
    expect(previous).toMatchObject({ id: lastNight, costUsd: 0.38 });
    expect(previous?.steps[0]).toMatchObject({ stepId: stepA, featureTitle: "Cover src/tiles.ts", incrementId: incId, now: "at your seal", yours: true, costUsd: 0.38 });
    expect(previous?.steps[1]).toMatchObject({ stepId: stepB, nothingNeeded: "Lint reports no warnings.", yours: false });
    // The routine list now says which step is which.
    expect((await store.listWorkflows())[0]?.steps.map((s) => s.id)).toEqual([stepA, stepB]);

    // A stopped routine needs a person: it is on the Desk until dismissed.
    const views = new PlaceViews({
      db,
      diffs: new DiffReader(workspaces, "main"),
      work: new WorkViews(db, new AgentWorkLog(join(root, "packs"))),
      log: new AgentWorkLog(join(root, "packs")),
      proposals: new ProposalsInFlight(),
      quota: async () => ({ exhausted: false, windowKind: "five_hour" }),
      configuredRepoLabel: "repo",
      configuredRepoPath: repo,
      baseRef: "main",
    });
    expect((await views.desk()).stopped).toMatchObject([{ runId: tonight, routineName: "Nightly coverage", recipeName: "Cover an untested module", reason: "the repo could not be read" }]);
    await store.dismissStop(tonight);
    expect((await views.desk()).stopped).toEqual([]);
    // Dismissed, not forgotten: the firing keeps its outcome.
    expect((await store.firings(wfId))[0]?.steps[0]?.error).toBe("the repo could not be read");
  });

  it("says the routine asked and initialled, never you, including for work a routine made before it was recorded", async () => {
    const make = async (title: string) => {
      const featureId = randomUUID();
      const briefId = randomUUID();
      const incId = randomUUID();
      await db.feature.create({ data: { id: featureId, title, stage: "IMPLEMENTING", repoPath: repo, repoLabel: "repo" } });
      await db.briefVersion.create({ data: { id: briefId, featureId, version: 1, contentMd: "Remove an item." } });
      await db.increment.create({
        data: { id: incId, featureId, title: "Add removeItem", status: "CONTEXT_READY", stateJson: JSON.stringify({ status: "CONTEXT_READY" }), declaredSurface: [], briefVersionId: briefId, orderIndex: 0 },
      });
      return { featureId, incId };
    };
    const deps = {
      db,
      diffs: new DiffReader(workspaces, "main"),
      work: new WorkViews(db, new AgentWorkLog(join(root, "packs"))),
      log: new AgentWorkLog(join(root, "packs")),
      proposals: new ProposalsInFlight(),
      quota: async () => ({ exhausted: false, windowKind: "five_hour" }),
      configuredRepoLabel: "repo",
      configuredRepoPath: repo,
      baseRef: "main",
    };
    const views = new PlaceViews(deps);
    const titles = async (featureId: string) => (await views.thread(featureId)).events.slice(0, 2).map((e) => [e.who, e.title]);

    // Recorded as the routine's, from now on.
    const now = await make("Recorded");
    await db.featureEvent.create({ data: { id: randomUUID(), featureId: now.featureId, kind: "asked", payloadJson: JSON.stringify({ goal: "Add removeItem", routine: "Nightly cart" }) } });
    await db.featureEvent.create({ data: { id: randomUUID(), featureId: now.featureId, incrementId: now.incId, kind: "initialled", payloadJson: JSON.stringify({ routine: "Nightly cart" }), at: new Date(Date.now() + 1000) } });
    expect(await titles(now.featureId)).toEqual([
      ["signet", "The routine “Nightly cart” asked for this"],
      ["signet", "The routine “Nightly cart” initialled the plan"],
    ]);
    expect((await new StepViews(deps).sheet(now.incId)).askedBy).toBe("Nightly cart");

    // Made by a routine before that was recorded: its firing says so.
    const before = await make("Before");
    const wfId = randomUUID();
    await db.workflow.create({ data: { id: wfId, name: "Old routine", triggerJson: JSON.stringify({ kind: "manual" }) } });
    await db.workflowRun.create({ data: { id: randomUUID(), workflowId: wfId, triggeredBy: "manual", status: "succeeded", outcomeJson: JSON.stringify({ outcomes: [{ recipeName: "r", featureId: before.featureId, stepsQueued: 1, error: null, nothingNeeded: null }] }) } });
    await db.featureEvent.create({ data: { id: randomUUID(), featureId: before.featureId, incrementId: before.incId, kind: "initialled", payloadJson: "{}" } });
    expect(await titles(before.featureId)).toEqual([
      ["signet", "The routine “Old routine” asked for this"],
      ["signet", "The routine “Old routine” initialled the plan"],
    ]);

    // A person's own feature is still theirs.
    const mine = await make("Mine");
    await db.featureEvent.create({ data: { id: randomUUID(), featureId: mine.featureId, kind: "asked", payloadJson: JSON.stringify({ goal: "Add removeItem" }) } });
    await db.featureEvent.create({ data: { id: randomUUID(), featureId: mine.featureId, incrementId: mine.incId, kind: "initialled", payloadJson: "{}", at: new Date(Date.now() + 1000) } });
    expect(await titles(mine.featureId)).toEqual([
      ["you", "You asked"],
      ["you", "You initialled the plan"],
    ]);
  });

  it("puts every merge in the ledger, with its commit found in git when it was not recorded", async () => {
    await sealedStep();
    const views = new PlaceViews({
      db,
      diffs: new DiffReader(workspaces, "main"),
      work: new WorkViews(db, new AgentWorkLog(join(root, "packs"))),
      log: new AgentWorkLog(join(root, "packs")),
      proposals: new ProposalsInFlight(),
      quota: async () => ({ exhausted: false, windowKind: "five_hour" }),
      configuredRepoLabel: "repo",
      configuredRepoPath: repo,
      baseRef: "main",
    });
    const ledger = await views.ledger();
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    const deskView = await views.desk();
    expect(deskView.flow.landedToday).toBe(1);
    expect(deskView.decisions).toEqual([]);
  });
});
