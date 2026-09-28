// Reads the diff an increment produced, so the human being asked for
// signature 2 can see what they are signing. A "review & merge" button with
// nothing to review is a rubber stamp, not a signature.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { parseUnifiedDiff } from "../domain/gates/promises.js";

const pexec = promisify(execFile);

/** A diff big enough to be unreviewable is itself the finding, so we cap and say so. */
const MAX_DIFF_BYTES = 200_000;

export interface IncrementDiff {
  readonly available: boolean;
  /** Why it is not available, when it is not. */
  readonly reason?: string;
  readonly files: readonly { readonly path: string; readonly added: number; readonly removed: number }[];
  readonly patch: string;
  readonly truncated: boolean;
}

export class DiffReader {
  constructor(
    private readonly workspacesRoot: string,
    private readonly baseRef: string,
  ) {}

  /** The commit the step's work stands at, or null when it has no workspace. */
  async head(incrementId: string): Promise<string | null> {
    try {
      const { stdout } = await pexec("git", ["rev-parse", "HEAD"], { cwd: join(this.workspacesRoot, `inc-${incrementId}`) });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * The new-side line ranges changed since a commit, per file: what a rebuild did after
   * it was sent back, so the note can be shown against the lines it produced.
   */
  async changedSince(incrementId: string, sha: string): Promise<Array<{ file: string; from: number; to: number }>> {
    try {
      const { stdout } = await pexec("git", ["diff", "-U0", sha], {
        cwd: join(this.workspacesRoot, `inc-${incrementId}`),
        maxBuffer: MAX_DIFF_BYTES * 4,
      });
      return [...parseUnifiedDiff(stdout).entries()].flatMap(([file, change]) => change.hunks.map(([from, to]) => ({ file, from, to })));
    } catch {
      return [];
    }
  }

  async read(incrementId: string): Promise<IncrementDiff> {
    const cwd = join(this.workspacesRoot, `inc-${incrementId}`);
    const empty = { files: [], patch: "", truncated: false };
    try {
      const { stdout: numstat } = await pexec("git", ["diff", "--numstat", this.baseRef], { cwd });
      const files = numstat
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((line) => {
          const [added, removed, path] = line.split("\t");
          return {
            path: path ?? "?",
            // "-" is git's marker for a binary file, where line counts are meaningless.
            added: added === "-" ? 0 : Number(added ?? 0),
            removed: removed === "-" ? 0 : Number(removed ?? 0),
          };
        });

      const { stdout: patch } = await pexec("git", ["diff", this.baseRef], {
        cwd,
        maxBuffer: MAX_DIFF_BYTES * 4,
      });
      const truncated = patch.length > MAX_DIFF_BYTES;
      return {
        available: true,
        files,
        patch: truncated ? patch.slice(0, MAX_DIFF_BYTES) : patch,
        truncated,
      };
    } catch (e) {
      // A missing worktree is the normal state at both ends of an increment's
      // life — before it starts and after the merge removes it — and from here
      // those are indistinguishable, so the message must not claim either.
      return {
        available: false,
        reason: (e as Error).message.includes("ENOENT")
          ? "There is no worktree for this increment: either it has not started yet, or it was removed after the merge."
          : (e as Error).message,
        ...empty,
      };
    }
  }
}
