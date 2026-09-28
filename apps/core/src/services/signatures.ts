// The two human signatures, as actions.
//   approve(increment)  — signature #1: CONTEXT_READY → RUNNING + enqueue the run
//   merge(increment)    — signature #2: AWAITING_SIGNATURE → MERGED + git merge
// Both are idempotency-guarded by the increment state machine itself: an
// illegal or concurrent transition throws a conflict and nothing happens.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  IncrementIdSchema,
  RunIdSchema,
  conflict,
  nonRecoverable,
  type IncrementId,
  type IncrementStatus,
} from "@signet/contracts";
import type { UnitOfWork } from "../domain/runtime/ports.js";
import { enqueueRun } from "./dispatcher.js";

const pexec = promisify(execFile);

export class Signatures {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly targetRepoPath: string,
    private readonly baseRef: string,
  ) {}

  /**
   * Where this increment's branch should be merged. A feature can target its own repo,
   * so merging into the configured one regardless would land the work in the wrong
   * codebase — silently, and with a real commit. Falls back to the configured repo,
   * which is what a feature with no repo of its own means.
   */
  repoForIncrement?: (incrementId: string) => Promise<string | null>;

  /**
   * Fired after a successful merge, so automation can react to work landing. Optional
   * and awaited with its errors swallowed: an automation that throws must never make a
   * merge that already happened look like it failed.
   */
  onMerged?: (incrementId: string) => Promise<void>;

  /**
   * Removes the increment's worktree once the work has landed.
   *
   * Nothing reaped them before, so they accumulated indefinitely — fourteen on the pilot
   * machine, the oldest two days old. That was tolerable while a worktree was 40kB of
   * tracked files. It stopped being tolerable the moment worktrees started carrying a
   * clone of node_modules so the gates could run: the one against a real package was
   * 67MB on its own, which is over a gigabyte after twenty runs.
   *
   * Merged is the right moment and the only safe one. The commits are in the repository,
   * the diff reads from git rather than the worktree, and DiffView already has a sentence
   * for a worktree that was removed after a merge. An escalated, parked or failed step
   * keeps its worktree, because that is where the evidence is.
   */
  releaseWorktree?: (incrementId: string) => Promise<void>;

  /**
   * The promises in "done when" that the latest run did not prove. Optional: without it,
   * or for a run from before promises were checked, there is nothing to hold the seal on.
   */
  unprovenPromises?: (incrementId: string) => Promise<string[]>;

  /** The thread's record of initials and seals. Best-effort, like the other hooks. */
  onSigned?: (event: { kind: "initialled" | "merged"; incrementId: string; payload: Record<string, unknown> }) => Promise<void>;

  /** Signature #1 — approve the increment; the run starts. */
  async approve(incrementId: string): Promise<{ runId: string }> {
    const incId = IncrementIdSchema.parse(incrementId);
    // Check it exists before enqueueing: otherwise the first failure is a
    // foreign-key violation from inside the run insert, which reaches the
    // caller as a database error rather than "no such increment".
    await this.requireIncrement(incId);
    const runId = await enqueueRun(this.uow, incId);
    await this.uow.run(async (tx) => {
      await tx.increments.transition(incId, "CONTEXT_READY", {
        status: "RUNNING",
        runId: RunIdSchema.parse(runId),
      });
    });
    await this.onSigned?.({ kind: "initialled", incrementId: incId, payload: {} }).catch(() => {});
    return { runId };
  }

  /**
   * The branch a repo currently has checked out, or the literal "HEAD" when detached.
   *
   * `--abbrev-ref HEAD` is the one that answers "what branch am I on" rather than "what
   * commit is this", and it yields "HEAD" for a detached checkout — which is a case worth
   * naming separately, because "on branch HEAD" would be a confusing thing to be told.
   */
  private async currentBranch(repoPath: string): Promise<string> {
    const { stdout } = await pexec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
    return stdout.trim();
  }

  /**
   * Signature #2 — merge the increment's branch into the base.
   *
   * `onTrust` is the explicit choice to land work whose promises are not all proven. It is
   * recorded on the step and in the merge commit, so every promise that was taken on trust
   * can be found later — a seal on trust is allowed, but never a default.
   */
  async merge(incrementId: string, opts: { onTrust?: boolean } = {}): Promise<void> {
    const incId = IncrementIdSchema.parse(incrementId);
    // Check the state BEFORE touching git. The transition below also guards,
    // but it runs after the merge — so without this an increment that is not
    // awaiting signature would have its branch merged into the base branch and
    // only then be refused, leaving unreviewed code in the repository.
    const current = await this.requireIncrement(incId);
    if (current !== "AWAITING_SIGNATURE") {
      throw Object.assign(new Error(`increment ${incId} is ${current}, not AWAITING_SIGNATURE`), {
        signet: conflict("increment.illegal_transition", `${current} -> MERGED`),
      });
    }
    // Checked before git, like everything else here: refusing after the merge would leave
    // unproven work on main.
    const unproven = (await this.unprovenPromises?.(incId)) ?? [];
    if (unproven.length > 0 && opts.onTrust !== true) {
      throw Object.assign(new Error(`${unproven.length} promise(s) unproven`), {
        signet: conflict(
          "merge.unproven",
          `${unproven.length === 1 ? "One thing you agreed to has" : `${unproven.length} things you agreed to have`} no test proving ${unproven.length === 1 ? "it" : "them"}: ` +
            `${unproven.map((p) => `“${p}”`).join("; ")}. Ask for the missing test, or seal on trust.`,
        ),
      });
    }
    const onTrust = opts.onTrust === true && unproven.length > 0 ? unproven : null;

    const branch = `signet/inc-${incId}`;
    const repoPath = (await this.repoForIncrement?.(incId)) ?? this.targetRepoPath;

    // Refuse unless the repo is actually ON the base branch.
    //
    // `git merge` merges into whatever is checked out. There is no checkout in this path,
    // so a repo sitting on some other branch would receive the work THERE — silently, and
    // with a real commit, because the increment's branch was cut from the base and applies
    // cleanly either way. You would press a button labelled "merge into your main branch"
    // and land it somewhere else.
    //
    // Refusing rather than checking out the base ourselves: a checkout can fail, can move
    // somebody's working state, and can stash. Signet should not relocate a developer's
    // HEAD as a side effect of a merge — it should say what is wrong and let them decide.
    const head = await this.currentBranch(repoPath);
    if (head !== this.baseRef) {
      throw Object.assign(
        new Error(`${repoPath} is on ${head}, not ${this.baseRef}`),
        {
          signet: conflict(
            "merge.wrong_branch",
            head === "HEAD"
              ? `That repository has a detached HEAD, so there is no branch to merge into. ` +
                `Check out ${this.baseRef} and try again.`
              : `That repository is on "${head}", not "${this.baseRef}". Merging now would land ` +
                `this work on "${head}" instead. Check out "${this.baseRef}" and try again.`,
          ),
        },
      );
    }

    await pexec(
      "git",
      [
        "-c",
        "user.name=signet",
        "-c",
        "user.email=signet@local",
        "merge",
        "--no-ff",
        "-m",
        `signet: merge increment ${incId}`,
        ...(onTrust ? ["-m", `Sealed on trust — not proven by a test:\n${onTrust.map((p) => `- ${p}`).join("\n")}`] : []),
        branch,
      ],
      { cwd: repoPath },
    );
    // The commit it landed as — the ledger's seal carries it, and taking the step back
    // later reverts exactly this commit.
    const sha = await pexec("git", ["rev-parse", "HEAD"], { cwd: repoPath })
      .then((r) => r.stdout.trim())
      .catch(() => null);
    await this.uow.run(async (tx) => {
      await tx.increments.transition(incId, "AWAITING_SIGNATURE", {
        status: "MERGED",
        mergedAt: new Date().toISOString(),
        ...(onTrust ? { onTrust } : {}),
        ...(sha ? { sha } : {}),
      });
    });
    await this.onSigned?.({ kind: "merged", incrementId: incId, payload: { sha, onTrust: onTrust ?? [] } }).catch(() => {});

    // After the transition, never inside it: the merge is done and recorded, and a
    // downstream automation failing is not a reason to report that it was not.
    try {
      await this.onMerged?.(incId);
    } catch {
      /* automation is best-effort; the merge stands */
    }
    try {
      await this.releaseWorktree?.(incId);
    } catch {
      /* tidying up is best-effort too: a merge that happened must not report failure
         because a directory could not be deleted */
    }
  }

  /** The increment's current status, or a not-found the HTTP layer maps to 404. */
  private async requireIncrement(incId: IncrementId): Promise<IncrementStatus> {
    const row = await this.uow.run(async (tx) => tx.increments.get(incId));
    if (!row) {
      throw Object.assign(new Error(`increment not found: ${incId}`), {
        signet: nonRecoverable("increment.not_found", `no increment with id ${incId}`),
      });
    }
    return row.state.status;
  }

  get base(): string {
    return this.baseRef;
  }
}
