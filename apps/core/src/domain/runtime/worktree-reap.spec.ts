// Reaping a worktree after the work has landed.
//
// Nothing did this, so they accumulated indefinitely — fourteen on the pilot machine, the
// oldest two days old. That was tolerable while a worktree held 40kB of tracked files. It
// stopped being tolerable the moment worktrees started carrying a clone of node_modules so
// the gates could actually run: the one against a real package measured 67MB on its own,
// which is over a gigabyte after twenty runs.
//
// The subtle half is the PRUNE. Deleting the directory without telling git leaves the
// registration behind, and `git worktree list` then reports it as "prunable" forever. That
// is how the litter first became visible, and deleting a directory is the easy thing to get
// half right.

import { afterAll, describe, expect, it } from "vitest";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { removeWorktreeFor } from "./worktree-manager.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const INC = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** A repo with one real worktree for INC, plus its lock file. */
async function fixture(): Promise<{ repo: string; workspaces: string }> {
  const base = await mkdtemp(join(tmpdir(), "signet-reap-"));
  roots.push(base);
  const repo = join(base, "repo");
  const workspaces = join(base, "workspaces");
  await mkdir(repo, { recursive: true });
  await mkdir(workspaces, { recursive: true });

  const git = (args: string[]) => exec("git", args, { cwd: repo });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "t@t"]);
  await git(["config", "user.name", "t"]);
  await writeFile(join(repo, "a.txt"), "one\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "first"]);
  await git(["worktree", "add", "-q", "-B", `signet/inc-${INC}`, join(workspaces, `inc-${INC}`), "main"]);
  await writeFile(join(workspaces, `inc-${INC}.lock`), String(process.pid));
  return { repo, workspaces };
}

describe("removing a merged step's worktree", () => {
  it("deletes the directory and the lock", async () => {
    const { repo, workspaces } = await fixture();
    await removeWorktreeFor({ workspacesRoot: workspaces, repoPath: repo, incrementId: INC });
    await expect(access(join(workspaces, `inc-${INC}`))).rejects.toThrow();
    await expect(access(join(workspaces, `inc-${INC}.lock`))).rejects.toThrow();
  });

  it("clears git's registration, so nothing is left 'prunable'", async () => {
    // The half that is easy to miss. A plain rm -rf leaves the registration, and
    // `git worktree list` then carries a prunable entry forever.
    const { repo, workspaces } = await fixture();
    await removeWorktreeFor({ workspacesRoot: workspaces, repoPath: repo, incrementId: INC });
    const { stdout } = await exec("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).not.toContain(`inc-${INC}`);
    expect(stdout).not.toContain("prunable");
  });

  it("recovers when git refuses, by deleting and pruning", async () => {
    // `git worktree remove` fails on a dirty worktree without --force, and on a variety of
    // states with it. The fallback has to leave the same end state.
    const { repo, workspaces } = await fixture();
    await writeFile(join(workspaces, `inc-${INC}`, "dirty.txt"), "uncommitted\n");
    await removeWorktreeFor({ workspacesRoot: workspaces, repoPath: repo, incrementId: INC });
    await expect(access(join(workspaces, `inc-${INC}`))).rejects.toThrow();
    const { stdout } = await exec("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).not.toContain("prunable");
  });

  it("is silent about a worktree that is already gone", async () => {
    // It runs after a merge that already landed, and it may run twice. Throwing here would
    // report a completed merge as failed, which is a lie about what happened.
    const { repo, workspaces } = await fixture();
    await removeWorktreeFor({ workspacesRoot: workspaces, repoPath: repo, incrementId: INC });
    await expect(
      removeWorktreeFor({ workspacesRoot: workspaces, repoPath: repo, incrementId: INC }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when the repo path is nonsense", async () => {
    await expect(
      removeWorktreeFor({
        workspacesRoot: join(tmpdir(), "signet-nope"),
        repoPath: "/nonexistent/repo",
        incrementId: INC,
      }),
    ).resolves.toBeUndefined();
  });
});
