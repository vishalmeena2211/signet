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
  /**
   * Every step's status, in order.
   *
   * A count cannot distinguish the shapes that matter. "1/3 done" is the same sentence
   * for a feature with one step running and two queued, one step failed and two queued,
   * and one step waiting on your signature — three situations calling for three different
   * reactions. With the states in order the board can draw them, and the difference is
   * visible without reading a word.
   */
  stepStates: z.array(z.string()),
  /**
   * Which repo it builds into, for display. Null means the configured one — worth
   * surfacing now that a feature can target its own.
   */
  repoLabel: z.string().nullable(),
});
export type FeatureSummary = z.infer<typeof FeatureSummarySchema>;

/**
 * What the operator asked for, as they wrote it.
 *
 * Versioned because answering a question amends it: the answer becomes a new
 * version rather than editing the old one, so "what was this built against" always
 * has an answer. Each step records which version it was built from.
 */
export const BriefVersionViewSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  contentMd: z.string(),
  frozenAt: z.iso.datetime(),
});
export type BriefVersionView = z.infer<typeof BriefVersionViewSchema>;

export const IncrementDetailSchema = z.object({
  id: IncrementIdSchema,
  featureId: FeatureIdSchema,
  title: z.string().min(1),
  state: IncrementStateSchema,
  declaredSurface: z.array(z.string()),
  repairAttempt: z.number().int().min(0),
  /** Which version of the request this step was built from. */
  briefVersionId: z.string(),
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
  /** Which repo to build into. Omitted means the configured one. */
  repoId: z.string().optional(),
  increments: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        declaredSurface: z.array(z.string().min(1)).min(1),
        /**
         * What "done" means for this step. Optional so the old shape still parses,
         * but every proposal fills it in — the context pack shipped an empty
         * acceptance.md to every run ever made, so no agent has been told what it
         * was aiming at.
         */
        acceptanceMd: z.string().optional(),
      }),
    )
    .min(1),
});
export type CreateFeatureRequest = z.infer<typeof CreateFeatureRequestSchema>;

// ── proposing a breakdown instead of demanding one ──
//
// Creating a feature used to require the user to name the steps AND the file globs
// each step could touch. Only somebody who already knows the codebase can answer
// that, and being wrong is not forgiving: a plan touching a file outside its declared
// surface is a NON-recoverable error, so the run dies with no repair. Two of the four
// items in the pilot's attention queue are that exact failure.
//
// So the guessing moves to the side holding the repository. The user says what they
// want; Signet surveys the repo and proposes the breakdown; the user approves or
// edits it. The surfaces do not disappear — they stop being the user's homework.

// ── which repository the work goes into ──
//
// Phase 0 had one repo per Signet instance, set by an env var, and the create form
// never mentioned it — so "which codebase is this going into" was answered by a
// config file nobody looked at. A feature now records its own target.

export const RepoOriginSchema = z.enum(["local", "github"]);
export type RepoOrigin = z.infer<typeof RepoOriginSchema>;

export const RepoOptionSchema = z.object({
  /** What the picker sends back: the absolute path for local, "owner/name" for github. */
  id: z.string(),
  label: z.string(),
  origin: RepoOriginSchema,
  /** Absolute path a run would use. Null for a github repo not yet cloned locally. */
  path: z.string().nullable(),
  /**
   * Whether a run can actually finish here. False for github, because merging means
   * pushing — auth, branches, pull requests — which is separate work. Saying so at the
   * point of choosing beats discovering it when the merge fails.
   */
  canMerge: z.boolean(),
  /** Why not, when canMerge is false. Null when there is nothing to warn about. */
  limitation: z.string().nullable(),
  /** Branch, description, or last-updated — whatever helps tell two repos apart. */
  detail: z.string().nullable(),
  /** True for the repo this instance is configured with, so it can be offered first. */
  isConfigured: z.boolean(),
});
export type RepoOption = z.infer<typeof RepoOptionSchema>;

export const RepoOptionsResponseSchema = z.object({
  repos: z.array(RepoOptionSchema),
  /** Where we looked, so an absent repo is explainable rather than mysterious. */
  scannedRoots: z.array(z.string()),
  github: z.object({ authenticated: z.boolean(), reason: z.string().nullable() }),
});
export type RepoOptionsResponse = z.infer<typeof RepoOptionsResponseSchema>;

export const ProposeFeatureRequestSchema = z.object({
  /**
   * What the user wants built, in their own words. The floor is deliberately higher
   * than one character: a proposal derived from "fix the thing" is a guess wearing a
   * plan's clothing, and it is kinder to refuse than to produce one.
   */
  goal: z.string().min(20).max(20_000),
  /**
   * Which repo to plan against. Omitted means the configured one, which keeps the
   * older request shape working.
   */
  repoId: z.string().optional(),
});
export type ProposeFeatureRequest = z.infer<typeof ProposeFeatureRequestSchema>;

export const ProposedStepSchema = z.object({
  title: z.string().min(1).max(200),
  /** Why this is its own step rather than part of a neighbour. */
  rationale: z.string().min(1),
  declaredSurface: z.array(z.string().min(1)).min(1),
  /** What "done" means, specifically enough to be checked. */
  acceptanceMd: z.string().min(1),
});
export type ProposedStep = z.infer<typeof ProposedStepSchema>;

export const SurfaceWarningSchema = z.object({
  stepTitle: z.string(),
  pattern: z.string(),
  /**
   * Why this surface is suspect. A glob matching nothing is the single most common
   * way a proposal looks reasonable and then kills the run it produced.
   */
  reason: z.enum(["matches_nothing", "matches_everything", "outside_repo"]),
});
export type SurfaceWarning = z.infer<typeof SurfaceWarningSchema>;

export const FeatureProposalSchema = z.object({
  title: z.string().min(1).max(200),
  /**
   * The goal restated as Signet understood it. Shown back before anything is built,
   * so a misread is caught while it is still cheap — the same reason the brief
   * read-back exists.
   */
  understanding: z.string().min(1),
  /**
   * Capped above, because a "breakdown" of thirty steps is not a plan a human can sign.
   *
   * NOT floored at one. An empty list is a legitimate and often CORRECT answer: a
   * maintenance recipe like "add tests to any module missing them" should return nothing
   * when every module already has tests. Requiring at least one step forces the agent to
   * either invent work or fail — and it failed, on the first real automated run, with
   * "steps Too small: expected array to have >=1 items" against a repo where the honest
   * answer was that there was nothing to do.
   *
   * For an automation that fires unattended every night, "must find something" is the
   * worst possible bias to build into a contract.
   */
  steps: z.array(ProposedStepSchema).max(12),
  /**
   * Why nothing needs doing, when steps is empty. Required in that case so "no work" is
   * always an explained conclusion rather than an empty result that could equally be a
   * malfunction.
   */
  noWorkNeeded: z.string().nullable().default(null),
  /**
   * What the proposer was unsure about. Carried rather than hidden: a plan that
   * hides its doubts is indistinguishable from a confident one, and the user is the
   * person who can resolve them.
   */
  uncertainties: z.array(z.string()),
});
export type FeatureProposal = z.infer<typeof FeatureProposalSchema>;

/**
 * A proposal with no steps must say why. Without this, an empty proposal and a broken one
 * look identical, and an automation that quietly does nothing is the hardest kind of
 * failure to notice.
 */
export const ValidatedFeatureProposalSchema = FeatureProposalSchema.refine(
  (p) => p.steps.length > 0 || (p.noWorkNeeded !== null && p.noWorkNeeded.trim().length > 0),
  { message: "a proposal with no steps must explain why nothing needs doing", path: ["noWorkNeeded"] },
);

export const FeatureProposalResponseSchema = z.object({
  proposal: FeatureProposalSchema,
  /** Which repo this was proposed against, so the user is never guessing. */
  repoPath: z.string(),
  repoLabel: z.string(),
  repoOrigin: RepoOriginSchema,
  /** Files the survey found. Zero means the proposal is built on nothing. */
  filesSurveyed: z.number().int(),
  /** True when the survey hit its ceiling, so the proposal saw only part of the repo. */
  surveyTruncated: z.boolean(),
  /** Surfaces that look wrong, checked against files that actually exist. */
  surfaceWarnings: z.array(SurfaceWarningSchema),
});
export type FeatureProposalResponse = z.infer<typeof FeatureProposalResponseSchema>;

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
