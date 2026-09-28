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
import { PlaceViews } from "./place-views.js";
import { WorkViews } from "./work-views.js";
import { AgentWorkLog } from "./agent-work.js";
import { DiffReader } from "./diff-reader.js";
import { FeatureEvents, ProposalsInFlight } from "./feature-events.js";
import { Controls } from "./controls.js";
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
        ]),
      },
    });
    const tests = await db.gateVerdict.create({ data: { id: randomUUID(), runId, gate: "tests", outcome: "pass", findingsJson: "[]" } });
    const work = new WorkViews(db, new AgentWorkLog(join(root, "packs")));

    const view = await work.promises(incId);
    expect(view.promises.map((p) => p.proven)).toEqual([true, true]);
    expect(view.promises[1]).toMatchObject({ bySuite: true });
    expect(await work.unproven(incId)).toEqual([]);

    // A tests check that found nothing to run proves nothing about the suite.
    await db.gateVerdict.update({ where: { id: tests.id }, data: { outcome: "skipped" } });
    expect(await work.unproven(incId)).toEqual(["npm test exits with code 0, and cart.test.mjs reports ok"]);
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
