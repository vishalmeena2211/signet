// Rule store + lifecycle. Findings enter as PROPOSED; a human confirms/edits/
// rejects; confirmed rules whose fp_count crosses threshold auto-demote and
// ask to be re-confirmed. Transitions are validated against the state machine —
// nothing is forced.

import { randomUUID } from "node:crypto";
import {
  ALLOWED_RULE_TRANSITIONS,
  RuleCardSchema,
  RuleCheckSchema,
  RuleIdSchema,
  type EditRuleRequest,
  type Rule,
  type RuleCard,
  type RuleCheck,
  type RuleStatus,
} from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";
import { extractFromSource } from "../domain/learner/source-extractor.js";
import { mineTrends } from "../domain/learner/trend-miner.js";
import { analyzeDrift } from "../domain/learner/drift-analyzer.js";
import { proposalsFrom } from "../domain/learner/finding-to-rule.js";
import type { Logger } from "../domain/runtime/logger.js";

const FP_DEMOTE_THRESHOLD = 3;

export class RuleStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly log: Logger,
    /** Optional: without it the store behaves exactly as it did, with no automation. */
    private readonly events?: { publish(event: "rules_proposed", cause?: object): Promise<void> },
  ) {}

  /** Run the learner on a repo and enqueue fresh proposals (idempotent by statement). */
  async learn(repoPath: string, label: string): Promise<{ proposed: number; skipped: number }> {
    this.log.info("learn.start", { repoPath, label });
    const extraction = await extractFromSource(repoPath);
    const byHex = new Map<string, number>();
    for (const c of extraction.colors) byHex.set(c.hex, (byHex.get(c.hex) ?? 0) + 1);
    const candidates = [...byHex.entries()].sort((a, b) => b[1] - a[1]).slice(0, 120).map(([h]) => h);
    const trends = await mineTrends(repoPath, candidates);
    const analysis = analyzeDrift(extraction, trends);
    const proposals = proposalsFrom(analysis);

    // Skip proposals whose statement already exists for this repo (any status)
    // — re-learning should not spam the queue with dupes or resurrect rejects.
    const existing = await this.db.rule.findMany({ where: { repoLabel: label }, select: { statement: true } });
    const seen = new Set(existing.map((r) => r.statement));

    let proposed = 0;
    let skipped = 0;
    for (const r of proposals) {
      if (seen.has(r.statement)) {
        skipped++;
        continue;
      }
      await this.db.rule.create({
        data: {
          id: r.id,
          repoLabel: label,
          statement: r.statement,
          kind: r.kind,
          confidence: r.confidence,
          trend: r.trend,
          status: "PROPOSED",
          checkJson: r.check ? JSON.stringify(r.check) : null,
          exceptionsJson: "[]",
          fpCount: 0,
          sourceFindingKind: r.sourceFindingKind ?? null,
          evidence: {
            create: r.evidence.map((e) => ({
              id: randomUUID(),
              ref: e.ref,
              kind: e.kind,
              detail: e.detail ?? null,
            })),
          },
        },
      });
      proposed++;
    }
    this.log.info("learn.done", { repoPath, label, proposed, skipped });
    // Only when something new actually appeared. Firing on a learn that proposed
    // nothing would wake automation up for no reason on every re-scan.
    if (proposed > 0) await this.events?.publish("rules_proposed");
    return { proposed, skipped };
  }

  async queue(repoLabel?: string): Promise<RuleCard[]> {
    const rows = await this.db.rule.findMany({
      where: { status: { in: ["PROPOSED", "DEMOTED"] }, ...(repoLabel ? { repoLabel } : {}) },
      include: { evidence: true },
      orderBy: [{ confidence: "desc" }],
    });
    return rows.map((r) =>
      RuleCardSchema.parse({
        id: r.id,
        statement: r.statement,
        kind: r.kind,
        evidence: r.evidence.map((e) => ({ ref: e.ref, kind: e.kind, detail: e.detail ?? undefined })),
        confidence: r.confidence,
        trend: r.trend,
        status: r.status,
        fpCount: r.fpCount,
      }),
    );
  }

  async confirmedRules(repoLabel: string): Promise<Rule[]> {
    const rows = await this.db.rule.findMany({
      where: { repoLabel, status: "CONFIRMED" },
      include: { evidence: true },
    });
    return rows.map((r) => this.toRule(r));
  }

  private async transition(id: string, to: RuleStatus): Promise<void> {
    const ruleId = RuleIdSchema.parse(id);
    const row = await this.db.rule.findUniqueOrThrow({ where: { id: ruleId } });
    const from = row.status as RuleStatus;
    if (from !== to && !ALLOWED_RULE_TRANSITIONS[from].includes(to)) {
      throw new Error(`illegal rule transition ${from} -> ${to}`);
    }
    await this.db.rule.update({ where: { id: ruleId }, data: { status: to } });
  }

  async confirm(id: string): Promise<void> {
    await this.transition(id, "CONFIRMED");
  }
  async reject(id: string): Promise<void> {
    await this.transition(id, "REJECTED");
  }

  async edit(id: string, req: EditRuleRequest): Promise<void> {
    const ruleId = RuleIdSchema.parse(id);
    const data: { statement?: string; checkJson?: string | null } = {};
    if (req.statement !== undefined) data.statement = req.statement;
    if (req.check !== undefined) data.checkJson = req.check ? JSON.stringify(RuleCheckSchema.parse(req.check)) : null;
    await this.db.rule.update({ where: { id: ruleId }, data });
  }

  /** Record a false-positive dismissal; auto-demote at threshold. */
  async recordFalsePositive(id: string): Promise<{ demoted: boolean }> {
    const ruleId = RuleIdSchema.parse(id);
    const row = await this.db.rule.update({
      where: { id: ruleId },
      data: { fpCount: { increment: 1 } },
    });
    if (row.status === "CONFIRMED" && row.fpCount >= FP_DEMOTE_THRESHOLD) {
      await this.db.rule.update({ where: { id: ruleId }, data: { status: "DEMOTED" } });
      this.log.warn("rule.auto_demoted", { ruleId: id, fpCount: row.fpCount });
      return { demoted: true };
    }
    return { demoted: false };
  }

  private toRule(row: {
    id: string;
    statement: string;
    kind: string;
    confidence: number;
    trend: string;
    status: string;
    checkJson: string | null;
    exceptionsJson: string;
    fpCount: number;
    sourceFindingKind: string | null;
    evidence: Array<{ ref: string; kind: string; detail: string | null }>;
  }): Rule {
    const check: RuleCheck | null = row.checkJson ? RuleCheckSchema.parse(JSON.parse(row.checkJson)) : null; // signet-policy-allow: raw-json-parse -- validated by RuleCheckSchema on this line
    return {
      id: RuleIdSchema.parse(row.id),
      statement: row.statement,
      kind: row.kind as Rule["kind"],
      confidence: row.confidence,
      trend: row.trend as Rule["trend"],
      status: row.status as RuleStatus,
      check,
      exceptions: JSON.parse(row.exceptionsJson), // signet-policy-allow: raw-json-parse -- exceptions shape written by us
      fpCount: row.fpCount,
      evidence: row.evidence.map((e) => ({ ref: e.ref, kind: e.kind as Rule["evidence"][number]["kind"], detail: e.detail ?? undefined })),
      ...(row.sourceFindingKind ? { sourceFindingKind: row.sourceFindingKind } : {}),
    };
  }
}
