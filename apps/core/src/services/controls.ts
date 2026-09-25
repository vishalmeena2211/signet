// Console controls beyond the two signatures: create work, answer questions,
// retry failures, abort running increments. Every mutation flows through the
// state machine — illegal moves throw, nothing is forced.

import { randomUUID } from "node:crypto";
import {
  CreateFeatureRequestSchema,
  EscalationIdSchema,
  IncrementIdSchema,
  type CreateFeatureRequest,
} from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";
import type { UnitOfWork } from "../domain/runtime/ports.js";

export interface AbortRegistry {
  abort(runId: string): boolean; // true if a live worker was signalled
}

export class Controls {
  constructor(
    private readonly db: PrismaClient,
    private readonly uow: UnitOfWork,
    private readonly aborts: AbortRegistry,
  ) {}

  /** Create a feature + frozen brief v1 + its increments (all CONTEXT_READY). */
  async createFeature(input: CreateFeatureRequest): Promise<{ featureId: string }> {
    const req = CreateFeatureRequestSchema.parse(input);
    const featureId = randomUUID();
    const briefId = randomUUID();
    await this.db.$transaction(async (tx) => {
      await tx.feature.create({ data: { id: featureId, title: req.title, stage: "IMPLEMENTING" } });
      await tx.briefVersion.create({
        data: { id: briefId, featureId, version: 1, contentMd: req.briefMd },
      });
      let order = 0;
      for (const inc of req.increments) {
        await tx.increment.create({
          data: {
            id: randomUUID(),
            featureId,
            title: inc.title,
            status: "CONTEXT_READY",
            stateJson: JSON.stringify({ status: "CONTEXT_READY" }),
            declaredSurface: inc.declaredSurface,
            briefVersionId: briefId,
            orderIndex: order++,
          },
        });
      }
    });
    return { featureId };
  }

  /**
   * Answer an escalation: record the answer, amend the brief (new frozen
   * version = old content + Q&A appendix), revive the increment.
   */
  async answerEscalation(escalationId: string, answer: string): Promise<void> {
    const escId = EscalationIdSchema.parse(escalationId);
    const esc = await this.db.escalation.findUniqueOrThrow({ where: { id: escId } });
    const escState = JSON.parse(esc.stateJson) as { question?: string }; // signet-policy-allow: raw-json-parse -- narrow shape read; written by us
    const inc = await this.db.increment.findUniqueOrThrow({ where: { id: esc.incrementId } });
    const oldBrief = await this.db.briefVersion.findUniqueOrThrow({ where: { id: inc.briefVersionId } });

    const newBriefId = randomUUID();
    const newVersion = oldBrief.version + 1;
    const amended =
      oldBrief.contentMd +
      `\n\n---\n## Clarification ${newVersion - 1} (answered escalation)\n**Q:** ${escState.question ?? "(question)"}\n**A:** ${answer}\n`;

    await this.db.$transaction(async (tx) => {
      await tx.briefVersion.create({
        data: { id: newBriefId, featureId: inc.featureId, version: newVersion, contentMd: amended },
      });
      await tx.escalation.update({
        where: { id: escId },
        data: { status: "ANSWERED", stateJson: JSON.stringify({ status: "ANSWERED", answer }) },
      });
      await tx.increment.update({
        where: { id: inc.id },
        data: { briefVersionId: newBriefId },
      });
    });

    await this.uow.run(async (tx) => {
      await tx.increments.transition(IncrementIdSchema.parse(inc.id), "ESCALATED", {
        status: "CONTEXT_READY",
      });
    });
  }

  /** Retry a failed increment: revive to CONTEXT_READY with reset budgets. */
  async retry(incrementId: string): Promise<void> {
    const incId = IncrementIdSchema.parse(incrementId);
    await this.uow.run(async (tx) => {
      await tx.increments.transition(incId, "FAILED", { status: "CONTEXT_READY" });
    });
    await this.db.increment.update({
      where: { id: incId },
      data: { repairAttempt: 0, freshRestarts: 0 },
    });
  }

  /** Abort a running increment: signal the live worker, mark run + increment. */
  async abort(incrementId: string): Promise<{ signalled: boolean }> {
    const incId = IncrementIdSchema.parse(incrementId);
    const inc = await this.db.increment.findUniqueOrThrow({ where: { id: incId } });
    const state = JSON.parse(inc.stateJson) as { status: string; runId?: string }; // signet-policy-allow: raw-json-parse -- narrow shape read; written by us
    if (state.status !== "RUNNING" || !state.runId) {
      throw new Error("only RUNNING increments can be aborted");
    }
    const signalled = this.aborts.abort(state.runId);
    await this.db.run.update({
      where: { id: state.runId },
      data: {
        status: "ABORTED",
        stateJson: JSON.stringify({ status: "ABORTED", reason: "aborted by user" }),
        finishedAt: new Date(),
      },
    });
    await this.uow.run(async (tx) => {
      await tx.increments.transition(incId, "RUNNING", { status: "FAILED", reason: "aborted by user" });
    });
    return { signalled };
  }
}
