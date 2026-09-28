// Worktree manager — one isolated git worktree per increment, atomic checkout
// under an execution lock, sync-back through the local working directory as the
// ONLY cross-run persistence path (the no-remote-git contract). Workers never
// push; the master owns every remote interaction.

import { mkdir, rm, rmdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { conflict, nonRecoverable, type SignetError } from "@signet/contracts";

const exec = promisify(execFile);

export interface WorktreeHandle {
  path: string;
  branch: string;
  lockPath: string;
  /**
   * The repo this worktree was added to. Carried on the handle because `git worktree
   * remove` has to run in the SAME repo that added it — with the repo only on the
   * manager, a feature targeting a non-default repo would have its worktree created in
   * one repo and removed from another, which fails confusingly and leaks the worktree.
   */
  repoPath: string;
}

export type WorktreeResult<T> = { ok: true; value: T } | { ok: false; error: SignetError };

/**
 * Removes one increment's worktree without needing a handle.
 *
 * `release()` needs the handle it was given at acquire time, which the merge path does not
 * have — the merge happens long after the run that created the worktree finished, often in
 * a different process. This is the same three-step teardown: ask git, fall back to deleting
 * the directory, prune the stale registration either way.
 *
 * Every failure is swallowed. This is called after a merge that has already landed, and a
 * directory that will not delete is not a reason to report that the merge did not happen.
 */
export async function removeWorktreeFor(input: {
  workspacesRoot: string;
  repoPath: string;
  incrementId: string;
}): Promise<void> {
  const path = join(input.workspacesRoot, `inc-${input.incrementId}`);
  const lockPath = join(input.workspacesRoot, `inc-${input.incrementId}.lock`);
  const git = (args: string[]) => exec("git", args, { cwd: input.repoPath });

  try {
    await git(["worktree", "remove", "--force", path]);
  } catch {
    await rm(path, { recursive: true, force: true }).catch(() => {});
    // Without the prune, git keeps the registration and reports the worktree as
    // "prunable" forever — visible in `git worktree list` and confusing to read.
    await git(["worktree", "prune"]).catch(() => {});
  }
  await rm(lockPath, { force: true }).catch(() => {});
}

export class WorktreeManager {
  constructor(
    private readonly repoPath: string, // the target project's main checkout
    private readonly workspacesRoot: string, // parent dir for all worktrees
  ) {}

  private async git(args: string[], cwd: string): Promise<string> {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  }

  /**
   * Create (or reuse, on crash-recovery) the worktree for an increment.
   * Lock protocol: a lock file created exclusively; holding pid recorded.
   * A live foreign pid → conflict error (dispatcher re-queues); a dead pid's
   * lock is stale and gets replaced (crash recovery).
   */
  async acquire(
    incrementId: string,
    baseRef: string,
    /**
     * The repo to branch from. Omitted means the instance default, which is what every
     * increment created before features could name their own repo means.
     */
    repoPath: string = this.repoPath,
  ): Promise<WorktreeResult<WorktreeHandle>> {
    const path = join(this.workspacesRoot, `inc-${incrementId}`);
    const branch = `signet/inc-${incrementId}`;
    const lockPath = join(this.workspacesRoot, `inc-${incrementId}.lock`);

    await mkdir(this.workspacesRoot, { recursive: true });

    const existing = await this.readLock(lockPath);
    if (existing !== null && existing !== process.pid && this.pidAlive(existing)) {
      return {
        ok: false,
        error: conflict("workspace.locked", `worktree held by live pid ${existing}`),
      };
    }
    await writeFile(lockPath, String(process.pid), "utf8");

    const exists = await access(path)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      try {
        // -B: (re)create branch at baseRef even if it exists from a torn run
        await this.git(["worktree", "add", "-B", branch, path, baseRef], repoPath);
        // A worktree holds TRACKED files only, so dependencies are absent.
        await this.provideDependencies(repoPath, path);
      } catch (e) {
        await rm(lockPath, { force: true });
        return {
          ok: false,
          error: nonRecoverable("workspace.create_failed", `git worktree add: ${String(e)}`),
        };
      }
    }
    return { ok: true, value: { path, branch, lockPath, repoPath } };
  }

  /**
   * Makes the target repo's installed dependencies available inside the worktree.
   *
   * Why this has to exist: `git worktree add` gives you the TRACKED files, and
   * node_modules is gitignored in every JavaScript project ever written. So a fresh
   * worktree has no tsc, no vitest, no eslint — and every gate exits 127, "command not
   * found". Signet looked like it worked for weeks because the demo repo runs
   * `node run-tests.mjs`, which needs nothing installed. The first run against a real
   * package escalated after burning three repairs trying to fix correct tests against an
   * error that had nothing to do with them.
   *
   * Three strategies, best first:
   *
   *   1. A COPY-ON-WRITE CLONE (`cp -c` on APFS, `--reflink` on btrfs/xfs). Effectively
   *      instant and genuinely isolated: the worktree gets its own view, and a write
   *      inside it cannot reach the target repo. This is the one we want.
   *   2. A SYMLINK, when the filesystem cannot clone. Also instant, but SHARED — a write
   *      into node_modules would reach the real repo. node_modules is gitignored, so such
   *      a change would never show up in the diff a human signs, which is exactly why it
   *      is the fallback and not the default.
   *   3. Nothing, if neither works. The gates will then skip or fail loudly rather than
   *      silently passing, which is the right way round.
   *
   * Deliberately NOT running an install: it needs network, takes minutes per increment,
   * and would make every run depend on a registry being reachable. Signet uses what the
   * developer already installed.
   */
  private async provideDependencies(repoPath: string, worktreePath: string): Promise<void> {
    // Only what a toolchain actually needs to execute. Kept short on purpose: each entry
    // is a directory being shared or cloned, and guessing wrongly is worse than omitting.
    const candidates = ["node_modules"];

    for (const dir of candidates) {
      const source = join(repoPath, dir);
      const target = join(worktreePath, dir);
      const hasSource = await access(source)
        .then(() => true)
        .catch(() => false);
      if (!hasSource) continue;

      // Already there (a resumed worktree): leave it alone.
      const hasTarget = await access(target)
        .then(() => true)
        .catch(() => false);
      if (hasTarget) continue;

      // 1) copy-on-write clone: isolated and instant where the filesystem supports it.
      const cloned = await exec("cp", ["-Rc", source, target])
        .then(() => true)
        .catch(() => false);
      if (cloned) continue;

      const reflinked = await exec("cp", ["-R", "--reflink=always", source, target])
        .then(() => true)
        .catch(() => false);
      if (reflinked) continue;

      // 2) symlink: shared, and the caller should know that.
      await exec("ln", ["-sfn", source, target]).catch(() => {
        // 3) neither worked. Left absent on purpose: a gate that cannot find its tools
        // fails loudly, which is far better than one that quietly reports success.
      });
    }
  }

  /** Commit everything in the worktree with a deterministic message; returns commit sha or null when clean. */
  async commitAll(handle: WorktreeHandle, message: string): Promise<string | null> {
    await this.discardOwnArtifacts(handle.path);
    await this.git(["add", "-A"], handle.path);
    const status = await this.git(["status", "--porcelain"], handle.path);
    if (status === "") return null;
    await this.git(
      ["-c", "user.name=signet", "-c", "user.email=signet@local", "commit", "-m", message],
      handle.path,
    );
    return this.git(["rev-parse", "HEAD"], handle.path);
  }

  /**
   * Files Signet writes into the worktree for its own purposes. They must never
   * reach a commit: the customer's repository would gain our sandbox profile in
   * its history at merge, and the scope checker would have to be taught to
   * ignore paths outside the increment's declared surface.
   *
   * Restoring rather than deleting is deliberate — a repository that tracks its
   * own .claude/settings.json gets its version back, instead of losing it.
   */
  private async discardOwnArtifacts(worktreePath: string): Promise<void> {
    const own = [".claude/settings.json"];
    for (const rel of own) {
      // Tracked in the repo? Put the committed version back.
      try {
        await this.git(["checkout", "--", rel], worktreePath);
        continue;
      } catch {
        // Not tracked, so there is nothing to restore — remove ours.
      }
      await rm(join(worktreePath, rel), { force: true });
    }
    // Remove the directory only when we are the reason it exists. rmdir fails
    // on a non-empty directory, which is exactly the guard we want: a
    // repository with its own .claude/ contents keeps them.
    await rmdir(join(worktreePath, ".claude")).catch(() => {});
  }

  /** Diff of the worktree branch against its base — what the gates judge. */
  async diffAgainst(handle: WorktreeHandle, baseRef: string): Promise<string> {
    return this.git(["diff", `${baseRef}...HEAD`, "--stat=200"], handle.path);
  }

  async changedFiles(handle: WorktreeHandle, baseRef: string): Promise<string[]> {
    const out = await this.git(["diff", `${baseRef}...HEAD`, "--name-only"], handle.path);
    return out === "" ? [] : out.split("\n");
  }

  /** Release the lock; keep or remove the worktree. */
  async release(handle: WorktreeHandle, opts: { removeWorktree: boolean }): Promise<void> {
    if (opts.removeWorktree) {
      try {
        await this.git(["worktree", "remove", "--force", handle.path], handle.repoPath);
      } catch {
        await rm(handle.path, { recursive: true, force: true });
        try {
          await this.git(["worktree", "prune"], handle.repoPath);
        } catch {
          /* prune is best-effort */
        }
      }
    }
    await rm(handle.lockPath, { force: true });
  }

  private async readLock(lockPath: string): Promise<number | null> {
    try {
      const raw = await readFile(lockPath, "utf8");
      const pid = Number(raw.trim());
      return Number.isInteger(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM = the process exists but belongs to another user — very much alive.
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}
