// State machines for Increment, Run, Rule, Escalation — discriminated unions.
// Transitions are validated by the runtime against ALLOWED_* maps below;
// persisting an illegal transition is impossible through the repositories.

import { z } from "zod";
import { EscalationIdSchema, QuotaWindowIdSchema, RunIdSchema } from "./ids.js";

// ── Increment ────────────────────────────────────────────────────────────────

export const IncrementStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("PLANNED") }),
  z.object({ status: z.literal("CONTEXT_READY") }),
  z.object({ status: z.literal("RUNNING"), runId: RunIdSchema }),
  z.object({ status: z.literal("VERIFYING"), runId: RunIdSchema }),
  z.object({ status: z.literal("AWAITING_SIGNATURE"), runId: RunIdSchema, prUrl: z.string().optional() }),
  z.object({
    status: z.literal("MERGED"),
    mergedAt: z.iso.datetime(),
    /** Promises landed without proof, by an explicit choice at the seal. Absent means none. */
    onTrust: z.array(z.string()).optional(),
    /** The merge commit on main. Absent for merges from before it was recorded. */
    sha: z.string().optional(),
  }),
  z.object({ status: z.literal("ESCALATED"), escalationId: EscalationIdSchema }),
  z.object({ status: z.literal("PARKED"), quotaWindowId: QuotaWindowIdSchema, resumeAt: z.iso.datetime() }),
  z.object({
    status: z.literal("FAILED"),
    reason: z.string(),
    /** Set when a person has seen the failure and put it away. It leaves the Desk; trying again clears it. */
    dismissedAt: z.iso.datetime().optional(),
  }),
]);
export type IncrementState = z.infer<typeof IncrementStateSchema>;
export type IncrementStatus = IncrementState["status"];

export const ALLOWED_INCREMENT_TRANSITIONS: Record<IncrementStatus, readonly IncrementStatus[]> = {
  PLANNED: ["CONTEXT_READY"],
  CONTEXT_READY: ["RUNNING", "PARKED"],
  RUNNING: ["VERIFYING", "ESCALATED", "PARKED", "FAILED"],
  VERIFYING: ["AWAITING_SIGNATURE", "RUNNING", "ESCALATED", "FAILED"], // VERIFYING→RUNNING = repair loop
  AWAITING_SIGNATURE: ["MERGED", "RUNNING", "FAILED"],
  MERGED: [],
  ESCALATED: ["CONTEXT_READY", "FAILED"], // answered escalation re-enters with amended brief
  PARKED: ["CONTEXT_READY", "RUNNING"],
  FAILED: ["CONTEXT_READY"], // human retry revives a failed increment
};

// ── Run ──────────────────────────────────────────────────────────────────────
// A run is one attempt at one increment. Phases are its recovery points.

export const RunPhaseNameSchema = z.enum([
  "ASSEMBLE_PACK",
  "CREATE_WORKSPACE",
  "AGENT_PLAN",
  "SCOPE_CHECK",
  "AGENT_IMPLEMENT",
  "GATES",
  "FINALIZE",
]);
export type RunPhaseName = z.infer<typeof RunPhaseNameSchema>;

export const RUN_PHASE_ORDER: readonly RunPhaseName[] = [
  "ASSEMBLE_PACK",
  "CREATE_WORKSPACE",
  "AGENT_PLAN",
  "SCOPE_CHECK",
  "AGENT_IMPLEMENT",
  "GATES",
  "FINALIZE",
];

export const RunStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("CREATED") }),
  z.object({ status: z.literal("PHASE"), phase: RunPhaseNameSchema, attempt: z.number().int().min(1) }),
  z.object({ status: z.literal("SUCCEEDED") }),
  z.object({ status: z.literal("FAILED"), errorCode: z.string(), errorKind: z.enum(["recoverable", "non_recoverable", "conflict"]) }),
  z.object({ status: z.literal("ABORTED"), reason: z.string() }),
]);
export type RunState = z.infer<typeof RunStateSchema>;

// ── Rule ─────────────────────────────────────────────────────────────────────

export const RuleStatusSchema = z.enum([
  "PROPOSED",
  "CONFIRMED",
  "REJECTED",
  "DEMOTED",
  "RETIRED",
  "SUPERSEDED",
]);
export type RuleStatus = z.infer<typeof RuleStatusSchema>;

export const ALLOWED_RULE_TRANSITIONS: Record<RuleStatus, readonly RuleStatus[]> = {
  PROPOSED: ["CONFIRMED", "REJECTED", "SUPERSEDED"],
  CONFIRMED: ["DEMOTED", "RETIRED", "SUPERSEDED"],
  DEMOTED: ["CONFIRMED", "RETIRED", "SUPERSEDED"], // re-confirmation after FP review
  REJECTED: [],
  RETIRED: [],
  SUPERSEDED: [],
};

// ── Escalation ───────────────────────────────────────────────────────────────

export const EscalationStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("RAISED"),
    question: z.string().min(1),
    /** Set when the agent wanted files outside the fence; answered with a choice, not prose. */
    fence: z
      .object({ outside: z.array(z.string()).min(1), reason: z.string().nullable(), surface: z.array(z.string()) })
      .optional(),
    /** Answers to choose from, when the question has them; free text is always allowed. */
    options: z.array(z.string()).optional(),
    /** Why it asked rather than chose. */
    why: z.string().optional(),
  }),
  z.object({ status: z.literal("ANSWERED"), answer: z.string().min(1) }),
  z.object({ status: z.literal("BRIEF_AMENDED"), newBriefVersion: z.number().int().min(1) }),
]);
export type EscalationState = z.infer<typeof EscalationStateSchema>;
