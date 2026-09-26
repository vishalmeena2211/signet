// Read models for the console. Reads go straight to Prisma (services may
// depend on persistence; the reverse is forbidden). Every payload leaving
// this class is a contracts schema instance.

import {
  ActivityViewSchema,
  EscalationViewSchema,
  FeatureSummarySchema,
  GateVerdictViewSchema,
  IncrementDetailSchema,
  IncrementStateSchema,
  QuotaStateViewSchema,
  type ActivityView,
  type EscalationView,
  type FeatureSummary,
  type GateVerdictView,
  type IncrementDetail,
  type QuotaStateView,
} from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";

/**
 * The increments are the truth about how far a feature got, so the board
 * derives the late stages instead of trusting the stored column — which is
 * written once at creation and would otherwise report "Implementing" forever
 * next to "1/1 increments merged". The early stages (intake, design,
 * decomposition) happen before any increment exists, so those still come from
 * the column.
 */
function deriveStage(stored: string, total: number, merged: number): string {
  if (total > 0 && merged === total) return "DONE";
  return stored;
}

export class ConsoleViews {
  constructor(private readonly db: PrismaClient) {}

  async featuresBoard(): Promise<FeatureSummary[]> {
    const features = await this.db.feature.findMany({
      orderBy: { updatedAt: "desc" },
      include: { increments: { select: { status: true } } },
    });
    return features.map((f) => {
      const total = f.increments.length;
      const merged = f.increments.filter((i) => i.status === "MERGED").length;
      const escalated = f.increments.some((i) => i.status === "ESCALATED");
      const awaiting = f.increments.some((i) => i.status === "AWAITING_SIGNATURE");
      const ready = f.increments.some((i) => i.status === "CONTEXT_READY");
      const needsHuman = escalated || awaiting || ready;
      const needsHumanWhy = escalated
        ? "An increment raised a question — answer it to resume."
        : awaiting
          ? "An increment passed all gates — review and merge."
          : ready
            ? "An increment is ready — approve it to start the run."
            : undefined;
      return FeatureSummarySchema.parse({
        id: f.id,
        title: f.title,
        needsHuman,
        ...(needsHumanWhy !== undefined ? { needsHumanWhy } : {}),
        stage: deriveStage(f.stage, total, merged),
        incrementsTotal: total,
        incrementsMerged: merged,
      });
    });
  }

  async featureDetail(featureId: string): Promise<{ feature: FeatureSummary; increments: IncrementDetail[] }> {
    const board = await this.featuresBoard();
    const feature = board.find((f) => f.id === featureId);
    if (!feature) throw new Error(`feature not found: ${featureId}`);
    const rows = await this.db.increment.findMany({
      where: { featureId },
      orderBy: { orderIndex: "asc" },
    });
    const increments = rows.map((r) =>
      IncrementDetailSchema.parse({
        id: r.id,
        featureId: r.featureId,
        title: r.title,
        state: IncrementStateSchema.parse(JSON.parse(r.stateJson)), // signet-policy-allow: raw-json-parse -- immediately schema-validated on this line
        declaredSurface: r.declaredSurface,
        repairAttempt: r.repairAttempt,
      }),
    );
    return { feature, increments };
  }

  async latestVerdicts(incrementId: string): Promise<GateVerdictView[]> {
    const lastRun = await this.db.run.findFirst({
      where: { incrementId },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    if (!lastRun) return [];
    const rows = await this.db.gateVerdict.findMany({
      where: { runId: lastRun.id },
      orderBy: { recordedAt: "asc" },
    });
    return rows.map((r) =>
      GateVerdictViewSchema.parse({
        gate: r.gate,
        outcome: r.outcome,
        findings: JSON.parse(r.findingsJson), // signet-policy-allow: raw-json-parse -- immediately schema-validated on this line
      }),
    );
  }

  async openEscalations(featureId: string): Promise<EscalationView[]> {
    const incs = await this.db.increment.findMany({ where: { featureId }, select: { id: true } });
    const rows = await this.db.escalation.findMany({
      where: { incrementId: { in: incs.map((i) => i.id) }, status: "RAISED" },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => {
      const st = JSON.parse(r.stateJson) as { question?: string }; // signet-policy-allow: raw-json-parse -- narrow shape read; written by us
      return EscalationViewSchema.parse({
        id: r.id,
        incrementId: r.incrementId,
        question: st.question ?? "(no question recorded)",
        raisedAt: r.createdAt.toISOString(),
      });
    });
  }

  async activity(incrementId: string): Promise<ActivityView> {
    const lastRun = await this.db.run.findFirst({
      where: { incrementId },
      orderBy: { startedAt: "desc" },
    });
    if (!lastRun) {
      return ActivityViewSchema.parse({
        phases: [],
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: null },
        lastError: null,
      });
    }
    const phases = await this.db.runPhase.findMany({
      where: { runId: lastRun.id },
      orderBy: { enteredAt: "asc" },
    });
    const usage = await this.db.usageLedgerEntry.aggregate({
      where: { runId: lastRun.id },
      _sum: { inputTokens: true, cachedInputTokens: true, outputTokens: true, costUsd: true },
    });
    const runState = JSON.parse(lastRun.stateJson) as { status: string; errorCode?: string; reason?: string }; // signet-policy-allow: raw-json-parse -- narrow shape read; written by us
    return ActivityViewSchema.parse({
      phases: phases.map((p) => ({
        phase: p.phase,
        attempt: p.attempt,
        enteredAt: p.enteredAt.toISOString(),
        completedAt: p.completedAt?.toISOString() ?? null,
      })),
      usage: {
        inputTokens: usage._sum.inputTokens ?? 0,
        cachedInputTokens: usage._sum.cachedInputTokens ?? 0,
        outputTokens: usage._sum.outputTokens ?? 0,
        costUsd: usage._sum.costUsd === null ? null : Number(usage._sum.costUsd),
      },
      lastError: runState.errorCode ?? runState.reason ?? null,
    });
  }

  async quotaState(activeWorkers: number): Promise<QuotaStateView> {
    const latest = await this.db.quotaWindow.findFirst({ orderBy: { observedAt: "desc" } });
    const exhausted =
      latest?.exhaustedAt != null && (latest.resetsAt === null || latest.resetsAt.getTime() > Date.now());
    return QuotaStateViewSchema.parse({
      windowKind: (latest?.kind ?? "five_hour") as "five_hour" | "weekly",
      exhausted,
      ...(latest?.resetsAt ? { resetsAt: latest.resetsAt.toISOString() } : {}),
      activeWorkers,
    });
  }
}
