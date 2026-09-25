// Worktree manager — one isolated git worktree per increment, atomic checkout
// under an execution lock, sync-back through the local working directory as the
// ONLY cross-run persistence path (the no-remote-git contract). Workers never
// push; the master owns every remote interaction.

import { mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { conflict, nonRecoverable, type SignetError } from "@signet/contracts";

const exec = promisify(execFile);

export interface WorktreeHandle {
  path: string;
  branch: string;
  lockPath: string;
}

export type WorktreeResult<T> = { ok: true; value: T } | { ok: false; error: SignetError };

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
  async acquire(incrementId: string, baseRef: string): Promise<WorktreeResult<WorktreeHandle>> {
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
        await this.git(["worktree", "add", "-B", branch, path, baseRef], this.repoPath);
      } catch (e) {
        await rm(lockPath, { force: true });
        return {
          ok: false,
          error: nonRecoverable("workspace.create_failed", `git worktree add: ${String(e)}`),
        };
      }
    }
    return { ok: true, value: { path, branch, lockPath } };
  }

  /** Commit everything in the worktree with a deterministic message; returns commit sha or null when clean. */
  async commitAll(handle: WorktreeHandle, message: string): Promise<string | null> {
    await this.git(["add", "-A"], handle.path);
    const status = await this.git(["status", "--porcelain"], handle.path);
    if (status === "") return null;
    await this.git(
      ["-c", "user.name=signet", "-c", "user.email=signet@local", "commit", "-m", message],
      handle.path,
    );
    return this.git(["rev-parse", "HEAD"], handle.path);
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
        await this.git(["worktree", "remove", "--force", handle.path], this.repoPath);
      } catch {
        await rm(handle.path, { recursive: true, force: true });
        try {
          await this.git(["worktree", "prune"], this.repoPath);
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
