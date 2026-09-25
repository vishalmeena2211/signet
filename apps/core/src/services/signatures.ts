// The two human signatures, as actions.
//   approve(increment)  — signature #1: CONTEXT_READY → RUNNING + enqueue the run
//   merge(increment)    — signature #2: AWAITING_SIGNATURE → MERGED + git merge
// Both are idempotency-guarded by the increment state machine itself: an
// illegal or concurrent transition throws a conflict and nothing happens.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IncrementIdSchema, RunIdSchema } from "@signet/contracts";
import type { UnitOfWork } from "../domain/runtime/ports.js";
import { enqueueRun } from "./dispatcher.js";

const pexec = promisify(execFile);

export class Signatures {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly targetRepoPath: string,
    private readonly baseRef: string,
  ) {}

  /** Signature #1 — approve the increment; the run starts. */
  async approve(incrementId: string): Promise<{ runId: string }> {
    const incId = IncrementIdSchema.parse(incrementId);
    const runId = await enqueueRun(this.uow, incId);
    await this.uow.run(async (tx) => {
      await tx.increments.transition(incId, "CONTEXT_READY", {
        status: "RUNNING",
        runId: RunIdSchema.parse(runId),
      });
    });
    return { runId };
  }

  /** Signature #2 — merge the increment's branch into the base. */
  async merge(incrementId: string): Promise<void> {
    const incId = IncrementIdSchema.parse(incrementId);
    const branch = `signet/inc-${incId}`;
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
      { cwd: this.targetRepoPath },
    );
    await this.uow.run(async (tx) => {
      await tx.increments.transition(incId, "AWAITING_SIGNATURE", {
        status: "MERGED",
        mergedAt: new Date().toISOString(),
      });
    });
  }

  get base(): string {
    return this.baseRef;
  }
}
