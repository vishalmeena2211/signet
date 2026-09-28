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
import { ProposalsInFlight } from "./feature-events.js";

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
