// API shapes for the Phase 0 endpoints. The Nest controllers validate with
// these; the UI client infers its types from the same schemas.

import { z } from "zod";
import { FeatureIdSchema, IncrementIdSchema } from "./ids.js";
import { IncrementStateSchema } from "./states.js";

export const FeatureSummarySchema = z.object({
  id: FeatureIdSchema,
  title: z.string().min(1),
  needsHuman: z.boolean(),
  needsHumanWhy: z.string().optional(), // plain language: what to do
  stage: z.enum(["INTAKE", "DESIGN", "DECOMPOSED", "IMPLEMENTING", "DONE"]),
  incrementsTotal: z.number().int().min(0),
  incrementsMerged: z.number().int().min(0),
});
export type FeatureSummary = z.infer<typeof FeatureSummarySchema>;

export const IncrementDetailSchema = z.object({
  id: IncrementIdSchema,
  featureId: FeatureIdSchema,
  title: z.string().min(1),
  state: IncrementStateSchema,
  declaredSurface: z.array(z.string()),
  repairAttempt: z.number().int().min(0),
});
export type IncrementDetail = z.infer<typeof IncrementDetailSchema>;

export const GateVerdictViewSchema = z.object({
  gate: z.enum(["typecheck", "lint", "tests", "conformance", "rules"]),
  outcome: z.enum(["pass", "fail", "warn", "skipped", "running"]),
  findings: z
    .array(
      z.object({
        dimension: z.string(), // e.g. "fail_then_pass", "position", "color"
        message: z.string(), // specific: "diverges in these 3 ways", never walls
        location: z.string().optional(),
      }),
    )
    .max(20), // signal discipline: top findings only, enforced at the type level
});
export type GateVerdictView = z.infer<typeof GateVerdictViewSchema>;

export const QuotaStateViewSchema = z.object({
  windowKind: z.enum(["five_hour", "weekly"]),
  exhausted: z.boolean(),
  resetsAt: z.iso.datetime().optional(),
  activeWorkers: z.number().int().min(0),
});
export type QuotaStateView = z.infer<typeof QuotaStateViewSchema>;

// ── console control requests ──

export const CreateFeatureRequestSchema = z.object({
  title: z.string().min(1).max(200),
  briefMd: z.string().min(1),
  increments: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        declaredSurface: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});
export type CreateFeatureRequest = z.infer<typeof CreateFeatureRequestSchema>;

export const AnswerEscalationRequestSchema = z.object({
  answer: z.string().min(1),
});
export type AnswerEscalationRequest = z.infer<typeof AnswerEscalationRequestSchema>;

export const EscalationViewSchema = z.object({
  id: z.string(),
  incrementId: IncrementIdSchema,
  question: z.string(),
  raisedAt: z.iso.datetime(),
});
export type EscalationView = z.infer<typeof EscalationViewSchema>;

export const ActivityViewSchema = z.object({
  phases: z.array(
    z.object({
      phase: z.string(),
      attempt: z.number().int(),
      enteredAt: z.iso.datetime(),
      completedAt: z.iso.datetime().nullable(),
    }),
  ),
  usage: z.object({
    inputTokens: z.number().int(),
    cachedInputTokens: z.number().int(),
    outputTokens: z.number().int(),
    costUsd: z.number().nullable(),
  }),
  lastError: z.string().nullable(),
});
export type ActivityView = z.infer<typeof ActivityViewSchema>;

/** What the human is actually signing at signature 2. */
export const IncrementDiffViewSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  files: z.array(z.object({ path: z.string(), added: z.number().int(), removed: z.number().int() })),
  patch: z.string(),
  truncated: z.boolean(),
});
export type IncrementDiffView = z.infer<typeof IncrementDiffViewSchema>;

// WS events pushed to the console
export const RealtimeEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("increment_changed"), incrementId: IncrementIdSchema }),
  z.object({ kind: z.literal("feature_changed"), featureId: FeatureIdSchema }),
  z.object({ kind: z.literal("needs_you"), featureId: FeatureIdSchema, why: z.string() }),
  z.object({ kind: z.literal("quota_changed") }),
]);
export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
