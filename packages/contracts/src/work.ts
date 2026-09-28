// Shapes for watching work happen and judging it — the capabilities the redesigned
// console is built around:
//
//   · what the agent is doing, from its own to-do list and the files it touches;
//   · what each promise in "done when" is proven by;
//   · a fence the agent wanted to cross, raised as a question instead of a dead run;
//   · notes left on lines of a change, sending it back;
//   · the checks run once against main, before any work is judged by them;
//   · what happened while you were away.
//
// Everything here is either a read model over what the runtime records, or a request
// that flows through the existing state machine. None of it adds a table.

import { z } from "zod";
import { FeatureIdSchema, IncrementIdSchema, RunIdSchema } from "./ids.js";

// ── the agent at work ────────────────────────────────────────────────────────

/** One item on the agent's own to-do list, as Claude Code reports it. */
export const AgentTodoSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  /** The present-tense form ("Writing the test"), when the agent supplied one. */
  activeForm: z.string().optional(),
});
export type AgentTodo = z.infer<typeof AgentTodoSchema>;

/**
 * One thing the agent did, in the terms a person watching would use. Tool names are
 * mapped here, once, so no screen has to know what "MultiEdit" means.
 */
export const AgentActionSchema = z.object({
  at: z.iso.datetime(),
  kind: z.enum(["read", "edit", "search", "command", "todos", "other"]),
  /** Repo-relative path for read/edit. */
  path: z.string().optional(),
  /** Command line for command, pattern for search, tool name for other. */
  text: z.string().optional(),
  /** The agent's own one-line reason, when the tool carries one (Bash does). */
  why: z.string().optional(),
  todos: z.array(AgentTodoSchema).optional(),
  /** Which phase produced it: planning reads, implementing writes. */
  phase: z.enum(["plan", "implement"]),
});
export type AgentAction = z.infer<typeof AgentActionSchema>;

/** A file in the map of the repo, sized by length. */
export const RepoMapFileSchema = z.object({
  path: z.string(),
  bytes: z.number().int().min(0),
  read: z.boolean(),
  changed: z.boolean(),
  /** Inside this step's fence. */
  fenced: z.boolean(),
  /** Wanted by the agent although outside the fence. */
  reached: z.boolean(),
});
export type RepoMapFile = z.infer<typeof RepoMapFileSchema>;

export const RunWorkViewSchema = z.object({
  runId: RunIdSchema,
  /** The latest to-do list the agent wrote, or empty if it never wrote one. */
  todos: z.array(AgentTodoSchema),
  /** Newest last, capped. */
  actions: z.array(AgentActionSchema),
  /** The neighbourhood of the repo the agent has been in, grouped by directory by the client. */
  files: z.array(RepoMapFileSchema),
  surface: z.array(z.string()),
});
export type RunWorkView = z.infer<typeof RunWorkViewSchema>;

// ── promises and their proof ────────────────────────────────────────────────

/**
 * What the agent claims proves a promise. Claimed by the agent, then CHECKED by Signet
 * against the diff: a claim naming a test that is not in the change is not proof.
 */
export const ProofClaimSchema = z.object({
  /** 1-based index into the promises listed in the prompt. */
  promise: z.number().int().min(1),
  test: z.string().nullable(),
  testFile: z.string().nullable().optional(),
  codeFile: z.string().nullable().optional(),
  /** "41-44" or "47". */
  codeLines: z.string().nullable().optional(),
});
export type ProofClaim = z.infer<typeof ProofClaimSchema>;

export const ProofClaimsSchema = z.object({ proofs: z.array(ProofClaimSchema) });

export const PromiseProofSchema = z.object({
  promise: z.string(),
  proven: z.boolean(),
  test: z.string().nullable(),
  testFile: z.string().nullable(),
  codeFile: z.string().nullable(),
  codeLines: z.string().nullable(),
  /** Why it is not proven, in a sentence. Null when proven. */
  reason: z.string().nullable(),
});
export type PromiseProof = z.infer<typeof PromiseProofSchema>;

export const PromisesViewSchema = z.object({
  /** False when the promises check never ran for the latest run (older runs, or none yet). */
  checked: z.boolean(),
  promises: z.array(PromiseProofSchema),
});
export type PromisesView = z.infer<typeof PromisesViewSchema>;

/** Signature 2. `onTrust` is the explicit choice to land with unproven promises. */
export const MergeRequestSchema = z.object({ onTrust: z.boolean().default(false) });
export type MergeRequest = z.infer<typeof MergeRequestSchema>;

// ── a fence the agent wanted to cross ───────────────────────────────────────

export const FenceQuestionSchema = z.object({
  /** Files it wanted that are outside the fence. */
  outside: z.array(z.string()).min(1),
  /** The agent's reason, when it gave one. */
  reason: z.string().nullable(),
  surface: z.array(z.string()),
});
export type FenceQuestion = z.infer<typeof FenceQuestionSchema>;

export const FenceAnswerRequestSchema = z.object({
  /**
   * widen — add the files to the fence and carry on (a change to what you initialled, so
   *         answering is the new initial);
   * split — make them their own step, before this one;
   * stay  — carry on without them.
   */
  choice: z.enum(["widen", "split", "stay"]),
});
export type FenceAnswerRequest = z.infer<typeof FenceAnswerRequestSchema>;

// ── notes on lines ──────────────────────────────────────────────────────────

export const LineNoteSchema = z.object({
  file: z.string().min(1).nullable(),
  /** New-side line number. Null for a note about the whole change. */
  line: z.number().int().min(1).nullable(),
  text: z.string().min(1).max(4000),
});
export type LineNote = z.infer<typeof LineNoteSchema>;

export const SendBackRequestSchema = z.object({ notes: z.array(LineNoteSchema).min(1).max(40) });
export type SendBackRequest = z.infer<typeof SendBackRequestSchema>;

// ── the checks, run once on main ────────────────────────────────────────────

export const BaselineCheckSchema = z.object({
  check: z.enum(["typecheck", "lint", "tests"]),
  /** What was run, as you would type it. Null when nothing was. */
  command: z.string().nullable(),
  outcome: z.enum(["pass", "fail", "skipped", "cannot_run"]),
  durationMs: z.number().int().min(0),
  /** One sentence: why skipped, what failed, or what cannot run. */
  detail: z.string().nullable(),
});
export type BaselineCheck = z.infer<typeof BaselineCheckSchema>;

export const BaselineReportSchema = z.object({
  repoPath: z.string(),
  repoLabel: z.string(),
  ref: z.string(),
  sha: z.string(),
  checkedAt: z.iso.datetime(),
  checks: z.array(BaselineCheckSchema),
});
export type BaselineReport = z.infer<typeof BaselineReportSchema>;

export const BaselineRequestSchema = z.object({ repoId: z.string().optional() });

// ── while you were away ─────────────────────────────────────────────────────

export const AwayEventSchema = z.object({
  at: z.iso.datetime(),
  kind: z.enum(["built", "question", "failed", "merged", "routine", "quota_out", "quota_back"]),
  text: z.string(),
  /** Needs you now. Drawn in the one colour that means you. */
  yours: z.boolean(),
  featureId: FeatureIdSchema.nullable(),
  incrementId: IncrementIdSchema.nullable(),
});
export type AwayEvent = z.infer<typeof AwayEventSchema>;

export const AwaySummarySchema = z.object({
  since: z.iso.datetime(),
  until: z.iso.datetime(),
  events: z.array(AwayEventSchema),
  waiting: z.object({ seal: z.number().int(), initial: z.number().int(), questions: z.number().int() }),
  /** Landed on main in the window. Only ever by a person — Signet cannot merge on its own. */
  merged: z.number().int(),
  spentUsd: z.number().nullable(),
  /** Where to start: the decision that finishes a feature, when there is one. */
  startWith: z
    .object({ featureId: FeatureIdSchema, incrementId: IncrementIdSchema, title: z.string(), why: z.string() })
    .nullable(),
});
export type AwaySummary = z.infer<typeof AwaySummarySchema>;
