// System-wide read models for the operator console.
//
// ConsoleViews answers questions about one feature. This answers questions
// about the whole instance: what needs a human, what is running right now, what
// has been spent, how reliable the last N runs were, and the full anatomy of any
// single run. Reads go straight to Prisma; every payload leaving here is a
// contracts schema instance.
//
// One rule throughout: a number that cannot be derived from the journal is
// returned as null, not zero. "We do not know what this cost" and "this cost
// nothing" are different facts and the console renders them differently.

import {
  ActivityEventSchema,
  AttentionItemSchema,
  EffectViewSchema,
  RunModelUsageSchema,
  OverviewSchema,
  PackViewSchema,
  RunDetailSchema,
  RunPhaseViewSchema,
  RunSummarySchema,
  SpendWindowSchema,
  type ActivityEvent,
  type AttentionItem,
  type Overview,
  type PackView,
  type QuotaStateView,
  type RunDetail,
  type RunOutcomeView,
  type RunSummary,
} from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";

/** Run.status as persisted → the outcome vocabulary the console shows. */
function outcomeOf(status: string): RunOutcomeView {
  switch (status) {
    case "SUCCEEDED":
      return "succeeded";
    case "FAILED":
      return "failed";
    case "ABORTED":
      return "aborted";
    case "PHASE":
      return "running";
    default:
      return "created";
  }
}

const IN_FLIGHT = ["RUNNING", "VERIFYING"];
const BLOCKED = ["FAILED", "ESCALATED", "PARKED"];

/** Decimal|null from Prisma → number|null, preserving "unpriced". */
function money(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export class OperatorViews {
  constructor(
    private readonly db: PrismaClient,
    private readonly deps: {
      quotaState: (activeWorkers: number) => Promise<QuotaStateView>;
      activeWorkers: () => number;
      dispatcherState: () => { paused: boolean; maxWorkers: number };
    },
  ) {}

  // ── overview ──

  async overview(): Promise<Overview> {
    const [quota, counts, attention, activeRuns, spend, reliability] = await Promise.all([
      this.deps.quotaState(this.deps.activeWorkers()),
      this.counts(),
      this.attention(),
      this.activeRuns(),
      this.spend(),
      this.reliability(),
    ]);
    const d = this.deps.dispatcherState();
    return OverviewSchema.parse({
      quota,
      dispatcher: { ...d, activeWorkers: this.deps.activeWorkers() },
      counts,
      attention,
      activeRuns,
      spend,
      reliability,
    });
  }

  private async counts() {
    const [features, incrementsTotal, incrementsMerged, inFlight, blocked] = await Promise.all([
      this.db.feature.count(),
      this.db.increment.count(),
      this.db.increment.count({ where: { status: "MERGED" } }),
      this.db.increment.count({ where: { status: { in: IN_FLIGHT } } }),
      this.db.increment.count({ where: { status: { in: BLOCKED } } }),
    ]);
    return { features, incrementsTotal, incrementsMerged, incrementsInFlight: inFlight, incrementsBlocked: blocked };
  }

  /**
   * The needs-you queue, oldest first — waiting longest is the strongest claim
   * on attention, and it is the number that embarrasses us if it grows.
   */
  private async attention(): Promise<AttentionItem[]> {
    const rows = await this.db.increment.findMany({
      where: { status: { in: ["CONTEXT_READY", "AWAITING_SIGNATURE", "ESCALATED", "FAILED"] } },
      include: { feature: { select: { id: true, title: true } } },
      orderBy: { updatedAt: "asc" },
      take: 50,
    });

    const escalations = new Map<string, string>();
    const escalated = rows.filter((r) => r.status === "ESCALATED").map((r) => r.id);
    if (escalated.length > 0) {
      const esc = await this.db.escalation.findMany({
        where: { incrementId: { in: escalated }, status: "RAISED" },
        orderBy: { createdAt: "desc" },
      });
      for (const e of esc) {
        if (!escalations.has(e.incrementId)) {
          const st = JSON.parse(e.stateJson) as { question?: string }; // signet-policy-allow: raw-json-parse -- narrow shape read; written by us
          escalations.set(e.incrementId, st.question ?? "A question was raised.");
        }
      }
    }

    return rows.map((r) => {
      const state = JSON.parse(r.stateJson) as { status: string; reason?: string }; // signet-policy-allow: raw-json-parse -- narrow shape read; written by us
      const { reason, detail } =
        r.status === "CONTEXT_READY"
          ? { reason: "awaiting_approval" as const, detail: "Ready to start — needs signature 1." }
          : r.status === "AWAITING_SIGNATURE"
            ? { reason: "awaiting_merge" as const, detail: "Passed every gate — needs signature 2." }
            : r.status === "ESCALATED"
              ? { reason: "question_raised" as const, detail: escalations.get(r.id) ?? "A question was raised." }
              : { reason: "failed" as const, detail: state.reason ?? "The run failed." };
      return AttentionItemSchema.parse({
        featureId: r.feature.id,
        featureTitle: r.feature.title,
        incrementId: r.id,
        incrementTitle: r.title,
        reason,
        detail,
        since: r.updatedAt.toISOString(),
      });
    });
  }

  private async activeRuns() {
    const runs = await this.db.run.findMany({
      where: { status: "PHASE" },
      include: {
        increment: { select: { id: true, title: true, featureId: true } },
        phases: { orderBy: { enteredAt: "desc" }, take: 1 },
      },
      orderBy: { startedAt: "asc" },
    });
    return runs.map((r) => {
      const last = r.phases[0];
      return {
        runId: r.id,
        incrementId: r.increment.id,
        incrementTitle: r.increment.title,
        featureId: r.increment.featureId,
        phase: last?.phase ?? "—",
        attempt: last?.attempt ?? 1,
        startedAt: r.startedAt.toISOString(),
        phaseEnteredAt: (last?.enteredAt ?? r.startedAt).toISOString(),
      };
    });
  }

  private async spend() {
    const now = Date.now();
    const windows: { label: string; since: Date }[] = [
      { label: "24 hours", since: new Date(now - 24 * 3600_000) },
      { label: "7 days", since: new Date(now - 7 * 24 * 3600_000) },
      { label: "all time", since: new Date(0) },
    ];
    return Promise.all(
      windows.map(async (w) => {
        const agg = await this.db.usageLedgerEntry.aggregate({
          where: { recordedAt: { gte: w.since } },
          _sum: { inputTokens: true, cachedInputTokens: true, outputTokens: true, costUsd: true },
        });
        const runs = await this.db.run.count({ where: { startedAt: { gte: w.since } } });
        return SpendWindowSchema.parse({
          label: w.label,
          runs,
          inputTokens: agg._sum.inputTokens ?? 0,
          cachedInputTokens: agg._sum.cachedInputTokens ?? 0,
          outputTokens: agg._sum.outputTokens ?? 0,
          costUsd: money(agg._sum.costUsd),
        });
      }),
    );
  }

  /** Over the last 50 finished runs: the honest pass rate, sample size included. */
  private async reliability() {
    const recent = await this.db.run.findMany({
      where: { status: { in: ["SUCCEEDED", "FAILED", "ABORTED"] } },
      orderBy: { startedAt: "desc" },
      take: 50,
      select: { status: true },
    });
    return {
      sample: recent.length,
      succeeded: recent.filter((r) => r.status === "SUCCEEDED").length,
      failed: recent.filter((r) => r.status === "FAILED").length,
      aborted: recent.filter((r) => r.status === "ABORTED").length,
    };
  }

  // ── runs ──

  async runs(opts: { outcome?: string; incrementId?: string; limit: number }): Promise<RunSummary[]> {
    const statusFilter =
      opts.outcome === undefined || opts.outcome === "all"
        ? {}
        : {
            status:
              opts.outcome === "running"
                ? "PHASE"
                : opts.outcome === "succeeded"
                  ? "SUCCEEDED"
                  : opts.outcome === "failed"
                    ? "FAILED"
                    : opts.outcome === "aborted"
                      ? "ABORTED"
                      : "CREATED",
          };
    const rows = await this.db.run.findMany({
      where: { ...statusFilter, ...(opts.incrementId ? { incrementId: opts.incrementId } : {}) },
      include: {
        increment: { select: { id: true, title: true, feature: { select: { id: true, title: true } } } },
        phases: { select: { attempt: true } },
        usage: { select: { inputTokens: true, outputTokens: true, costUsd: true } },
      },
      orderBy: { startedAt: "desc" },
      take: opts.limit,
    });

    const stories = await this.gateStoryByRun(rows.map((r) => r.id));

    return rows.map((r) => {
      const story = stories.get(r.id);
      const maxAttempt = r.phases.reduce((m, p) => Math.max(m, p.attempt), 1);
      return RunSummarySchema.parse({
        id: r.id,
        incrementId: r.increment.id,
        incrementTitle: r.increment.title,
        featureId: r.increment.feature.id,
        featureTitle: r.increment.feature.title,
        outcome: outcomeOf(r.status),
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
        phaseCount: r.phases.length,
        maxAttempt,
        gateRounds: story?.rounds ?? 0,
        // A repair shows up as either an extra phase attempt or an extra gate
        // round; take whichever is larger so neither path under-reports.
        repairs: Math.max(maxAttempt - 1, (story?.rounds ?? 1) - 1),
        inputTokens: r.usage.reduce((s, u) => s + u.inputTokens, 0),
        outputTokens: r.usage.reduce((s, u) => s + u.outputTokens, 0),
        // Unpriced models must not be summed as zero: if every entry is
        // unpriced the total is unknown, and the console says so.
        costUsd: r.usage.every((u) => u.costUsd === null)
          ? null
          : r.usage.reduce((s, u) => s + Number(u.costUsd ?? 0), 0),
        gatesFailed: story?.failed ?? [],
        gatesRepaired: story?.repaired ?? [],
      });
    });
  }

  /**
   * The gate story per run: how many rounds ran, what still failed at the end,
   * and what failed earlier but was repaired.
   *
   * Rounds are derived by counting verdicts per gate name — the suite records
   * exactly one verdict per gate per round, so the highest per-gate count IS the
   * round count. This matters because a repair loop re-runs the gates inside a
   * single phase attempt, so the RunPhase rows show attempt=1 even when two
   * rounds happened: reading repairs from phase attempts under-reports them.
   *
   * Separating "failed finally" from "failed then passed" matters just as much. A
   * conformance failure that the agent then fixed is the gate working, and listing
   * it beside a genuine blocker in the same column makes every successful repair
   * look like a defect.
   */
  private async gateStoryByRun(
    runIds: string[],
  ): Promise<Map<string, { rounds: number; failed: string[]; repaired: string[] }>> {
    const map = new Map<string, { rounds: number; failed: string[]; repaired: string[] }>();
    if (runIds.length === 0) return map;

    const verdicts = await this.db.gateVerdict.findMany({
      where: { runId: { in: runIds } },
      select: { runId: true, gate: true, outcome: true, recordedAt: true },
      orderBy: { recordedAt: "asc" },
    });

    const byRun = new Map<string, typeof verdicts>();
    for (const v of verdicts) {
      const list = byRun.get(v.runId) ?? [];
      list.push(v);
      byRun.set(v.runId, list);
    }

    for (const [runId, list] of byRun) {
      const perGate = new Map<string, { outcomes: string[] }>();
      for (const v of list) {
        const e = perGate.get(v.gate) ?? { outcomes: [] };
        e.outcomes.push(v.outcome);
        perGate.set(v.gate, e);
      }
      const rounds = Math.max(1, ...[...perGate.values()].map((e) => e.outcomes.length));

      const failed: string[] = [];
      const repaired: string[] = [];
      for (const [gate, e] of perGate) {
        const last = e.outcomes[e.outcomes.length - 1];
        const everFailed = e.outcomes.includes("fail");
        if (last === "fail") failed.push(gate);
        else if (everFailed) repaired.push(gate);
      }
      map.set(runId, { rounds, failed, repaired });
    }
    return map;
  }

  async runDetail(runId: string): Promise<RunDetail | null> {
    const run = await this.db.run.findUnique({
      where: { id: runId },
      include: {
        increment: { select: { id: true, title: true, feature: { select: { id: true, title: true } } } },
        phases: { orderBy: [{ enteredAt: "asc" }] },
        usage: true,
        effects: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!run) return null;

    const story = (await this.gateStoryByRun([run.id])).get(run.id);
    const maxAttempt = run.phases.reduce((m, p) => Math.max(m, p.attempt), 1);
    const byModel = new Map<string, { calls: number; input: number; cached: number; output: number; cost: number | null }>();
    for (const u of run.usage) {
      const cur = byModel.get(u.model) ?? { calls: 0, input: 0, cached: 0, output: 0, cost: null };
      cur.calls += 1;
      cur.input += u.inputTokens;
      cur.cached += u.cachedInputTokens;
      cur.output += u.outputTokens;
      if (u.costUsd !== null) cur.cost = (cur.cost ?? 0) + Number(u.costUsd);
      byModel.set(u.model, cur);
    }

    return RunDetailSchema.parse({
      summary: RunSummarySchema.parse({
        id: run.id,
        incrementId: run.increment.id,
        incrementTitle: run.increment.title,
        featureId: run.increment.feature.id,
        featureTitle: run.increment.feature.title,
        outcome: outcomeOf(run.status),
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
        phaseCount: run.phases.length,
        maxAttempt,
        gateRounds: story?.rounds ?? 0,
        repairs: Math.max(maxAttempt - 1, (story?.rounds ?? 1) - 1),
        inputTokens: run.usage.reduce((s, u) => s + u.inputTokens, 0),
        outputTokens: run.usage.reduce((s, u) => s + u.outputTokens, 0),
        costUsd: run.usage.every((u) => u.costUsd === null)
          ? null
          : run.usage.reduce((s, u) => s + Number(u.costUsd ?? 0), 0),
        gatesFailed: story?.failed ?? [],
        gatesRepaired: story?.repaired ?? [],
      }),
      phases: run.phases.map((p) =>
        RunPhaseViewSchema.parse({
          phase: p.phase,
          attempt: p.attempt,
          enteredAt: p.enteredAt.toISOString(),
          completedAt: p.completedAt?.toISOString() ?? null,
          durationMs: p.completedAt ? p.completedAt.getTime() - p.enteredAt.getTime() : null,
        }),
      ),
      usageByModel: [...byModel.entries()].map(([model, v]) =>
        RunModelUsageSchema.parse({
          model,
          calls: v.calls,
          inputTokens: v.input,
          cachedInputTokens: v.cached,
          outputTokens: v.output,
          costUsd: v.cost,
        }),
      ),
      effects: run.effects.map((e) =>
        EffectViewSchema.parse({
          kind: e.kind,
          phase: e.phase,
          status: e.status,
          idempotencyKey: e.idempotencyKey,
          attempt: e.attempt,
          createdAt: e.createdAt.toISOString(),
        }),
      ),
      sessionRef: run.sessionRef,
      workspacePath: run.workspacePath,
      stateJson: run.stateJson,
    });
  }

  // ── what the agent knew ──

  async pack(incrementId: string): Promise<PackView | null> {
    const run = await this.db.run.findFirst({
      where: { incrementId },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    if (!run) return null;
    const manifest = await this.db.contextPackManifest.findUnique({ where: { runId: run.id } });
    if (!manifest) return null;

    const parsed = JSON.parse(manifest.manifestJson) as { // signet-policy-allow: raw-json-parse -- validated by PackViewSchema below
      sections?: { name?: string; bytes?: number; sha256?: string }[];
    };
    const sections = (parsed.sections ?? []).map((s) => ({
      name: s.name ?? "(unnamed)",
      bytes: s.bytes ?? 0,
      sha256: s.sha256 ?? "",
    }));
    return PackViewSchema.parse({
      runId: run.id,
      packHash: manifest.packHash,
      assembledAt: manifest.assembledAt.toISOString(),
      sections,
      totalBytes: sections.reduce((s, x) => s + x.bytes, 0),
    });
  }

  // ── activity feed ──

  /**
   * A feed reconstructed from the journal rather than a second log. The runtime
   * already records phases, verdicts, escalations and run outcomes with
   * timestamps; replaying those is truthful by construction and survives a
   * restart, which an in-memory event buffer would not.
   */
  async activityFeed(limit: number): Promise<ActivityEvent[]> {
    // GateVerdict and Escalation carry ids but declare no Prisma relation, so
    // their owning increment is resolved with an explicit second query rather
    // than an include. Two small lookups beat widening the schema for a feed.
    const [phases, verdicts, runs, escalations] = await Promise.all([
      this.db.runPhase.findMany({ orderBy: { enteredAt: "desc" }, take: limit }),
      this.db.gateVerdict.findMany({ orderBy: { recordedAt: "desc" }, take: limit }),
      this.db.run.findMany({
        where: { finishedAt: { not: null } },
        orderBy: { finishedAt: "desc" },
        take: limit,
        include: { increment: { select: { id: true, title: true, featureId: true } } },
      }),
      this.db.escalation.findMany({ orderBy: { createdAt: "desc" }, take: limit }),
    ]);

    const runIds = [...new Set([...phases.map((p) => p.runId), ...verdicts.map((v) => v.runId)])];
    const runOwners = new Map(
      (
        await this.db.run.findMany({
          where: { id: { in: runIds } },
          select: { id: true, incrementId: true, increment: { select: { title: true, featureId: true } } },
        })
      ).map((r) => [r.id, r]),
    );
    const incOwners = new Map(
      (
        await this.db.increment.findMany({
          where: { id: { in: escalations.map((e) => e.incrementId) } },
          select: { id: true, title: true, featureId: true },
        })
      ).map((i) => [i.id, i]),
    );

    const events: ActivityEvent[] = [];

    for (const p of phases) {
      const owner = runOwners.get(p.runId);
      if (!owner) continue; // a run deleted under us is not worth inventing a row for
      events.push(
        ActivityEventSchema.parse({
          at: p.enteredAt.toISOString(),
          kind: "phase.entered",
          summary: `${owner.increment.title}: entered ${p.phase.toLowerCase()}${p.attempt > 1 ? ` (attempt ${p.attempt})` : ""}`,
          // A second attempt at a phase is a repair, which is worth noticing.
          severity: p.attempt > 1 ? "warn" : "info",
          featureId: owner.increment.featureId,
          incrementId: owner.incrementId,
          runId: owner.id,
        }),
      );
    }
    for (const v of verdicts) {
      const owner = runOwners.get(v.runId);
      if (!owner) continue;
      events.push(
        ActivityEventSchema.parse({
          at: v.recordedAt.toISOString(),
          kind: "gate.verdict",
          summary: `${owner.increment.title}: ${v.gate} ${v.outcome}`,
          severity: v.outcome === "fail" ? "error" : v.outcome === "warn" ? "warn" : "success",
          featureId: owner.increment.featureId,
          incrementId: owner.incrementId,
          runId: owner.id,
        }),
      );
    }
    for (const r of runs) {
      const outcome = outcomeOf(r.status);
      events.push(
        ActivityEventSchema.parse({
          at: (r.finishedAt ?? r.startedAt).toISOString(),
          kind: `run.${outcome}`,
          summary: `${r.increment.title}: run ${outcome}`,
          severity: outcome === "succeeded" ? "success" : outcome === "running" ? "info" : "error",
          featureId: r.increment.featureId,
          incrementId: r.increment.id,
          runId: r.id,
        }),
      );
    }
    for (const e of escalations) {
      const owner = incOwners.get(e.incrementId);
      if (!owner) continue;
      const st = JSON.parse(e.stateJson) as { question?: string }; // signet-policy-allow: raw-json-parse -- narrow shape read; written by us
      events.push(
        ActivityEventSchema.parse({
          at: e.createdAt.toISOString(),
          kind: "escalation.raised",
          summary: `${owner.title}: ${st.question ?? "a question was raised"}`,
          severity: "warn",
          featureId: owner.featureId,
          incrementId: owner.id,
        }),
      );
    }

    return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }
}
