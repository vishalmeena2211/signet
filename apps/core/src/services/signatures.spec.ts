// The two signatures refuse before they act.
//
// The merge path matters most: it runs `git merge` into the base branch, which
// is not undoable from the console. The state guard used to run only after that
// merge, so an increment that was never reviewed could have its branch landed
// and only then be refused. These tests pin the order.

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const exec = promisify(execFile);
const repos: string[] = [];
afterAll(async () => {
  for (const r of repos) await rm(r, { recursive: true, force: true });
});

/** A real git repo, on `branch`, so the branch guard has something true to read. */
async function repoOn(branch: string, opts: { detached?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "signet-sig-"));
  repos.push(root);
  const git = (args: string[]) => exec("git", args, { cwd: root });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "t@t"]);
  await git(["config", "user.name", "t"]);
  await writeFile(join(root, "a.txt"), "one\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "first"]);
  if (opts.detached) {
    const { stdout } = await git(["rev-parse", "HEAD"]);
    await git(["checkout", "-q", stdout.trim()]);
  } else if (branch !== "main") {
    await git(["checkout", "-q", "-b", branch]);
  }
  return root;
}

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

describe("the merge refuses to land on the wrong branch", () => {
  it("refuses when the repo is on a different branch than the base ref", async () => {
    // `git merge` merges into whatever is checked out, and there is no checkout in this
    // path. A repo sitting on a feature branch would receive the work THERE — silently,
    // with a real commit, because the increment branch was cut from the base and applies
    // cleanly either way. You would press "merge into your main branch" and land it
    // somewhere else entirely.
    const repo = await repoOn("feature/wip");
    const { uow, transitions } = fakeUow("AWAITING_SIGNATURE");
    const sigs = new Signatures(uow, repo, "main");

    await expect(sigs.merge(INC)).rejects.toMatchObject({
      signet: { kind: "conflict", code: "merge.wrong_branch" },
    });
    // Nothing was written, and no merge commit exists.
    expect(transitions).toEqual([]);
    const { stdout } = await exec("git", ["log", "--oneline"], { cwd: repo });
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  it("names both branches, so the message says what to do", async () => {
    const repo = await repoOn("feature/wip");
    const { uow } = fakeUow("AWAITING_SIGNATURE");
    const sigs = new Signatures(uow, repo, "main");
    await expect(sigs.merge(INC)).rejects.toMatchObject({
      signet: { message: expect.stringContaining("feature/wip") },
    });
    await expect(sigs.merge(INC)).rejects.toMatchObject({
      signet: { message: expect.stringContaining("main") },
    });
  });

  it("treats a detached HEAD as its own case, not as a branch called HEAD", async () => {
    // "That repository is on HEAD" would be a confusing thing to be told.
    const repo = await repoOn("main", { detached: true });
    const { uow } = fakeUow("AWAITING_SIGNATURE");
    const sigs = new Signatures(uow, repo, "main");
    await expect(sigs.merge(INC)).rejects.toMatchObject({
      signet: { code: "merge.wrong_branch", message: expect.stringContaining("detached") },
    });
  });

  it("allows the merge when the repo IS on the base ref", async () => {
    // The guard must not be so broad that signature 2 stops working. This one gets past
    // the branch check and fails later, at the git merge itself, because the fake unit of
    // work has no real increment branch — which is exactly how far we want it to get.
    const repo = await repoOn("main");
    const { uow } = fakeUow("AWAITING_SIGNATURE");
    const sigs = new Signatures(uow, repo, "main");
    await expect(sigs.merge(INC)).rejects.not.toMatchObject({
      signet: { code: "merge.wrong_branch" },
    });
  });
});
