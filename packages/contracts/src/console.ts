// Operator views: the shapes the console needs to answer questions about the
// whole system rather than one feature at a time.
//
// Everything here is a read model assembled from what the runtime already
// persists. Nothing in this file introduces new state — if a number cannot be
// derived from the journal, it does not belong on the screen, because an
// invented number is worse than an absent one.

import { z } from "zod";
import { FeatureIdSchema, IncrementIdSchema, RunIdSchema } from "./ids.js";
import { QuotaStateViewSchema } from "./api.js";

// ── overview ──

/** One thing a human has to do, with enough context to decide without clicking. */
export const AttentionItemSchema = z.object({
  featureId: FeatureIdSchema,
  featureTitle: z.string(),
  incrementId: IncrementIdSchema,
  incrementTitle: z.string(),
  /** Which of the two signatures, or a question, or a failure. */
  reason: z.enum(["awaiting_approval", "awaiting_merge", "question_raised", "failed"]),
  detail: z.string(),
  since: z.iso.datetime(),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

export const ActiveRunSchema = z.object({
  runId: RunIdSchema,
  incrementId: IncrementIdSchema,
  incrementTitle: z.string(),
  featureId: FeatureIdSchema,
  phase: z.string(),
  attempt: z.number().int(),
  startedAt: z.iso.datetime(),
  phaseEnteredAt: z.iso.datetime(),
});
export type ActiveRun = z.infer<typeof ActiveRunSchema>;

export const SpendWindowSchema = z.object({
  label: z.string(), // "today", "7 days"
  runs: z.number().int(),
  inputTokens: z.number().int(),
  cachedInputTokens: z.number().int(),
  outputTokens: z.number().int(),
  /** null when no model in the window had a known price — an honest gap, not zero. */
  costUsd: z.number().nullable(),
});
export type SpendWindow = z.infer<typeof SpendWindowSchema>;

export const OverviewSchema = z.object({
  quota: QuotaStateViewSchema,
  dispatcher: z.object({ paused: z.boolean(), maxWorkers: z.number().int(), activeWorkers: z.number().int() }),
  counts: z.object({
    features: z.number().int(),
    incrementsTotal: z.number().int(),
    incrementsMerged: z.number().int(),
    incrementsInFlight: z.number().int(),
    incrementsBlocked: z.number().int(),
  }),
  attention: z.array(AttentionItemSchema),
  activeRuns: z.array(ActiveRunSchema),
  spend: z.array(SpendWindowSchema),
  /** Success rate over the most recent finished runs, with the sample size shown. */
  reliability: z.object({
    sample: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    aborted: z.number().int(),
  }),
});
export type Overview = z.infer<typeof OverviewSchema>;

// ── runs ──

export const RunOutcomeViewSchema = z.enum(["running", "succeeded", "failed", "aborted", "created"]);
export type RunOutcomeView = z.infer<typeof RunOutcomeViewSchema>;

export const RunSummarySchema = z.object({
  id: RunIdSchema,
  incrementId: IncrementIdSchema,
  incrementTitle: z.string(),
  featureId: FeatureIdSchema,
  featureTitle: z.string(),
  outcome: RunOutcomeViewSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  durationMs: z.number().int().nullable(),
  phaseCount: z.number().int(),
  /** Highest attempt number seen across phases. */
  maxAttempt: z.number().int(),
  /**
   * How many times the gate suite ran. Two rounds means one repair happened,
   * and this is observed from the verdict history rather than self-reported —
   * a repair inside a single phase attempt is invisible to `maxAttempt`.
   */
  gateRounds: z.number().int(),
  repairs: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number().nullable(),
  /** Gates still failing in the FINAL round — the ones that actually blocked. */
  gatesFailed: z.array(z.string()),
  /**
   * Gates that failed in an earlier round and passed by the last one. This is the
   * gate doing its job, not the gate complaining, and conflating the two makes a
   * successful repair look like a failure.
   */
  gatesRepaired: z.array(z.string()),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunPhaseViewSchema = z.object({
  phase: z.string(),
  attempt: z.number().int(),
  enteredAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  durationMs: z.number().int().nullable(),
});
export type RunPhaseView = z.infer<typeof RunPhaseViewSchema>;

export const RunModelUsageSchema = z.object({
  model: z.string(),
  calls: z.number().int(),
  inputTokens: z.number().int(),
  cachedInputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number().nullable(),
});
export type RunModelUsage = z.infer<typeof RunModelUsageSchema>;

export const EffectViewSchema = z.object({
  kind: z.string(),
  phase: z.string(),
  status: z.string(),
  idempotencyKey: z.string(),
  attempt: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type EffectView = z.infer<typeof EffectViewSchema>;

export const RunDetailSchema = z.object({
  summary: RunSummarySchema,
  phases: z.array(RunPhaseViewSchema),
  usageByModel: z.array(RunModelUsageSchema),
  effects: z.array(EffectViewSchema),
  sessionRef: z.string().nullable(),
  workspacePath: z.string().nullable(),
  /** The run's terminal reason when it has one, straight from the persisted state. */
  stateJson: z.string(),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

// ── context pack: "what did the agent know" ──

export const PackSectionViewSchema = z.object({
  name: z.string(),
  bytes: z.number().int(),
  sha256: z.string(),
});
export type PackSectionView = z.infer<typeof PackSectionViewSchema>;

export const PackViewSchema = z.object({
  runId: RunIdSchema,
  packHash: z.string(),
  assembledAt: z.iso.datetime(),
  sections: z.array(PackSectionViewSchema),
  totalBytes: z.number().int(),
});
export type PackView = z.infer<typeof PackViewSchema>;

// ── activity feed ──

export const ActivityEventSchema = z.object({
  at: z.iso.datetime(),
  kind: z.string(), // run.started | phase.entered | gate.verdict | run.succeeded | escalation.raised …
  summary: z.string(),
  severity: z.enum(["info", "success", "warn", "error"]),
  featureId: FeatureIdSchema.optional(),
  incrementId: IncrementIdSchema.optional(),
  runId: RunIdSchema.optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

// ── system introspection ──

export const SystemCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});
export type SystemCheck = z.infer<typeof SystemCheckSchema>;

export const SystemInfoSchema = z.object({
  contractsVersion: z.string(),
  nodeVersion: z.string(),
  startedAt: z.iso.datetime(),
  uptimeSeconds: z.number().int(),
  config: z.object({
    host: z.string(),
    port: z.number().int(),
    targetRepoPath: z.string(),
    baseRef: z.string(),
    workspacesRoot: z.string(),
    packsRoot: z.string(),
    claudeBinary: z.string(),
    /** null = not pinned; the run uses the operator's own Claude Code default. */
    model: z.string().nullable(),
    maxConcurrentWorkers: z.number().int(),
    maxRepairIterations: z.number().int(),
    logLevel: z.string(),
  }),
  checks: z.array(SystemCheckSchema),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;

// ── operational control ──

export const DispatcherControlRequestSchema = z.object({
  paused: z.boolean().optional(),
  maxWorkers: z.number().int().min(1).max(16).optional(),
});
export type DispatcherControlRequest = z.infer<typeof DispatcherControlRequestSchema>;

export const DispatcherStateSchema = z.object({
  paused: z.boolean(),
  maxWorkers: z.number().int(),
  activeWorkers: z.number().int(),
});
export type DispatcherState = z.infer<typeof DispatcherStateSchema>;
