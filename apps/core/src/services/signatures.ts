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

  /** Signature #2 — merge the increment's branch into the base. */
  async merge(incrementId: string): Promise<void> {
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
        branch,
      ],
      { cwd: repoPath },
    );
    await this.uow.run(async (tx) => {
      await tx.increments.transition(incId, "AWAITING_SIGNATURE", {
        status: "MERGED",
        mergedAt: new Date().toISOString(),
      });
    });

    // After the transition, never inside it: the merge is done and recorded, and a
    // downstream automation failing is not a reason to report that it was not.
    try {
      await this.onMerged?.(incId);
    } catch {
      /* automation is best-effort; the merge stands */
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
