// Read models for the console. Reads go straight to Prisma (services may
// depend on persistence; the reverse is forbidden). Every payload leaving
// this class is a contracts schema instance.

import {
  FeatureSummarySchema,
  GateVerdictViewSchema,
  IncrementDetailSchema,
  IncrementStateSchema,
  QuotaStateViewSchema,
  type FeatureSummary,
  type GateVerdictView,
  type IncrementDetail,
  type QuotaStateView,
} from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";

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
        stage: f.stage,
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
