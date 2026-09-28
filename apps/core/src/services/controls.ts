// Console controls beyond the two signatures: create work, answer questions,
// retry failures, abort running increments. Every mutation flows through the
// state machine — illegal moves throw, nothing is forced.

import { randomUUID } from "node:crypto";
import {
  CreateFeatureRequestSchema,
  EscalationIdSchema,
  EscalationStateSchema,
  IncrementIdSchema,
  RunIdSchema,
  conflict,
  type CreateFeatureRequest,
  type FenceAnswerRequest,
  type LineNote,
} from "@signet/contracts";
import { enqueueRun } from "./dispatcher.js";
import type { FeatureEvents } from "./feature-events.js";
import type { PrismaClient } from "../persistence/generated/client.js";
import type { UnitOfWork } from "../domain/runtime/ports.js";

export interface AbortRegistry {
  abort(runId: string): boolean; // true if a live worker was signalled
}

export class Controls {
  /**
   * Turns what the picker sent into the repo to record. Optional so existing callers
   * and tests keep working without it.
   */
  resolveRepo?: (repoId: string | undefined) => { path: string; label: string; origin: string };

  /** Where the thread's events are written. Optional so existing callers keep working. */
  events?: FeatureEvents;

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
      // Recorded on the feature, not left implicit in an env var. A null repoPath
      // means "the configured one", which is what every feature created before this
      // existed means — so old rows keep working untouched.
      const repo = this.resolveRepo?.(req.repoId) ?? null;
      await tx.feature.create({
        data: {
          id: featureId,
          title: req.title,
          stage: "IMPLEMENTING",
          ...(repo ? { repoPath: repo.path, repoOrigin: repo.origin, repoLabel: repo.label } : {}),
        },
      });
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
            // Falls back to empty for the old request shape, which is the state every
            // increment created before now is already in. A proposal always supplies it.
            acceptanceMd: inc.acceptanceMd ?? "",
            briefVersionId: briefId,
            orderIndex: order++,
          },
        });
      }
    });
    if (req.asked) {
      await this.events?.record({ featureId, kind: "asked", at: new Date(req.asked.at), payload: { goal: req.asked.goal } });
    }
    if (req.proposal) {
      await this.events?.record({
        featureId,
        kind: "proposed",
        at: new Date(req.proposal.at),
        payload: { steps: req.increments.length, filesSurveyed: req.proposal.filesSurveyed, note: req.proposal.note },
      });
    }
    return { featureId };
  }

  /**
   * Answer an escalation: record the answer, amend the brief (new frozen
   * version = old content + Q&A appendix), revive the increment.
   */
  async answerEscalation(escalationId: string, answer: string): Promise<string> {
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
    await this.events?.record({ featureId: inc.featureId, incrementId: inc.id, kind: "answered", payload: { answer } });
    return inc.id;
  }

  /**
   * Answers "may I change files outside the fence" with a choice rather than prose.
   *
   *   widen — the files join the fence. A change to what was initialled, so the answer IS
   *           the new initial: the step starts again straight away.
   *   stay  — the agent is told to manage without them, and the step starts again.
   *   split — the files become their own step, placed before this one; both then wait
   *           for initials, the new one first.
   *
   * Every answer is written into the request as a new version, like any other answer, so
   * the record of what the step was built from stays complete.
   */
  async answerFence(escalationId: string, req: FenceAnswerRequest): Promise<{ startNow: string | null }> {
    const escId = EscalationIdSchema.parse(escalationId);
    const esc = await this.db.escalation.findUniqueOrThrow({ where: { id: escId } });
    const state = EscalationStateSchema.safeParse(JSON.parse(esc.stateJson)); // signet-policy-allow: raw-json-parse -- validated by EscalationStateSchema on this line
    if (!state.success || state.data.status !== "RAISED" || !state.data.fence) {
      throw Object.assign(new Error("not an open fence question"), {
        signet: conflict("escalation.not_fence", "This question is not about the fence, or it was already answered."),
      });
    }
    const { question, fence } = state.data;
    const inc = await this.db.increment.findUniqueOrThrow({ where: { id: esc.incrementId } });
    const oldBrief = await this.db.briefVersion.findUniqueOrThrow({ where: { id: inc.briefVersionId } });
    const files = fence.outside.join(", ");

    const answer =
      req.choice === "widen"
        ? `Yes — ${files} may be changed in this step. The fence now includes ${fence.outside.length === 1 ? "it" : "them"}.`
        : req.choice === "stay"
          ? `No. Do not change ${files}. Find a way that only changes files inside the fence.`
          : `${files} will be changed by its own step, which lands before this one. Do not change ${fence.outside.length === 1 ? "it" : "them"} here.`;

    const newBriefId = randomUUID();
    const newVersion = oldBrief.version + 1;
    const amended =
      oldBrief.contentMd +
      `\n\n---\n## Clarification ${newVersion - 1} (the fence)\n**Q:** ${question}\n**A:** ${answer}\n`;

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
        data: {
          briefVersionId: newBriefId,
          ...(req.choice === "widen"
            ? { declaredSurface: [...new Set([...inc.declaredSurface, ...fence.outside])] }
            : {}),
        },
      });
      if (req.choice === "split") {
        // Make room at this step's position, so the new step runs first.
        await tx.increment.updateMany({
          where: { featureId: inc.featureId, orderIndex: { gte: inc.orderIndex } },
          data: { orderIndex: { increment: 1 } },
        });
        await tx.increment.create({
          data: {
            id: randomUUID(),
            featureId: inc.featureId,
            title: `Change ${fence.outside.map((f) => f.split("/").pop()).join(", ")} for “${inc.title}”`,
            status: "CONTEXT_READY",
            stateJson: JSON.stringify({ status: "CONTEXT_READY" }),
            declaredSurface: fence.outside,
            acceptanceMd:
              fence.reason !== null
                ? `- ${fence.reason}`
                : `- ${files} changed as “${inc.title}” needs, with a test proving the change`,
            briefVersionId: newBriefId,
            orderIndex: inc.orderIndex,
          },
        });
      }
    });

    await this.uow.run(async (tx) => {
      await tx.increments.transition(IncrementIdSchema.parse(inc.id), "ESCALATED", { status: "CONTEXT_READY" });
    });
    await this.events?.record({ featureId: inc.featureId, incrementId: inc.id, kind: "answered", payload: { answer } });
    return { startNow: req.choice === "split" ? null : inc.id };
  }

  /**
   * Sends a finished step back with notes on its lines, instead of landing it.
   *
   * Rejecting a whole step to fix one line is out of proportion. The notes are written
   * into the request — the same mechanism as answering a question, so they are part of
   * the record of what the step was built from — and a new run starts in the SAME
   * worktree, where the previous attempt is still committed. The agent changes what the
   * notes ask for, and the checks judge the whole change again.
   */
  async sendBack(incrementId: string, notes: LineNote[]): Promise<{ runId: string }> {
    const incId = IncrementIdSchema.parse(incrementId);
    const inc = await this.db.increment.findUniqueOrThrow({ where: { id: incId } });
    if (inc.status !== "AWAITING_SIGNATURE") {
      throw Object.assign(new Error(`increment ${incId} is ${inc.status}`), {
        signet: conflict("increment.illegal_transition", `Only a step waiting for your seal can be sent back; this one is ${inc.status.toLowerCase().replace(/_/g, " ")}.`),
      });
    }
    const oldBrief = await this.db.briefVersion.findUniqueOrThrow({ where: { id: inc.briefVersionId } });
    const newBriefId = randomUUID();
    const newVersion = oldBrief.version + 1;
    const lines = notes.map((n) => {
      const where = n.file ? `${n.file}${n.line !== null ? `:${n.line}` : ""} — ` : "";
      return `- ${where}${n.text.trim()}`;
    });
    const amended =
      oldBrief.contentMd +
      `\n\n---\n## Sent back at the seal (version ${newVersion})\n` +
      `Your previous attempt is already in this workspace. Keep what works, and change what these notes ask for:\n` +
      `${lines.join("\n")}\n`;

    await this.db.$transaction(async (tx) => {
      await tx.briefVersion.create({
        data: { id: newBriefId, featureId: inc.featureId, version: newVersion, contentMd: amended },
      });
      await tx.increment.update({ where: { id: incId }, data: { briefVersionId: newBriefId } });
    });

    const runId = await enqueueRun(this.uow, incId);
    await this.uow.run(async (tx) => {
      await tx.increments.transition(incId, "AWAITING_SIGNATURE", {
        status: "RUNNING",
        runId: RunIdSchema.parse(runId),
      });
    });
    await this.events?.record({
      featureId: inc.featureId,
      incrementId: incId,
      kind: "sent_back",
      payload: { notes: notes.length, first: notes[0]?.text ?? null },
    });
    return { runId };
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
