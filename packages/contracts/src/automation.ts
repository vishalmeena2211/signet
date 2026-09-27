// Automation: recipes, workflows, and the guards that keep them from running away.
//
// One concept with three faces, rather than three subsystems:
//
//   · A RECIPE is a saved request — a description, a target repo, optionally a fixed
//     step plan. Leave placeholders in it and it is a template you fill in; leave none
//     and it is a one-click action.
//   · A WORKFLOW is an ordered list of recipes plus a trigger.
//
// The line that does not move: automation runs work up to the point of landing it and
// then stops. A workflow can propose, plan, write and check; it cannot merge. Signature
// 2 stays human, because that is the signature that actually protects the base branch.
//
// Worth stating explicitly, because it is a real change rather than an implementation
// detail: for automated work, signature 1 becomes automatic. "A feature between two
// human signatures" becomes one human signature when a workflow starts the work. The
// second is the one that matters, but the first is genuinely being given up.

import { z } from "zod";

/** Placeholder syntax in a recipe's description: {{name}}. */
export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/** Every placeholder in a description, in order, without duplicates. */
export function placeholdersIn(goalMd: string): string[] {
  const found: string[] = [];
  for (const match of goalMd.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

export const RecipeSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  goalMd: z.string().min(20),
  repoPath: z.string().nullable(),
  repoOrigin: z.enum(["local", "github"]),
  repoLabel: z.string().nullable(),
  /**
   * Derived, not stored: a recipe with no placeholders can be run with one click, and
   * that is the whole difference between a template and an action.
   */
  placeholders: z.array(z.string()),
  createdAt: z.iso.datetime(),
});
export type Recipe = z.infer<typeof RecipeSchema>;

export const CreateRecipeRequestSchema = z.object({
  name: z.string().min(1).max(120),
  /** Same floor as a hand-typed goal: a plan from half a sentence is a guess. */
  goalMd: z.string().min(20).max(20_000),
  repoId: z.string().optional(),
});
export type CreateRecipeRequest = z.infer<typeof CreateRecipeRequestSchema>;

// ── triggers ──

export const ScheduleTriggerSchema = z.object({
  kind: z.literal("schedule"),
  /**
   * Deliberately not cron. Five opaque fields is a syntax people get wrong silently,
   * and the useful cases are few. "Every day at 09:00" is legible; "0 9 * * *" is a
   * thing you check twice and still get wrong.
   */
  every: z.enum(["hour", "day", "week"]),
  /** Minute past the hour, or time of day for day/week. 24-hour clock. */
  atHour: z.number().int().min(0).max(23).default(9),
  atMinute: z.number().int().min(0).max(59).default(0),
  /** 0 = Sunday. Only meaningful for `week`. */
  onWeekday: z.number().int().min(0).max(6).default(1),
});
export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;

/**
 * Signet's own events. Deliberately a short list: these are the moments where reacting
 * is obviously useful, and every addition is another way to build a loop.
 */
export const WorkflowEventSchema = z.enum([
  "step_merged",
  "run_failed",
  "rules_proposed",
  "quota_reset",
]);
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

export const EventTriggerSchema = z.object({
  kind: z.literal("event"),
  event: WorkflowEventSchema,
});
export type EventTrigger = z.infer<typeof EventTriggerSchema>;

export const ManualTriggerSchema = z.object({ kind: z.literal("manual") });

export const WorkflowTriggerSchema = z.discriminatedUnion("kind", [
  ScheduleTriggerSchema,
  EventTriggerSchema,
  ManualTriggerSchema,
]);
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  /** Off by default. An automation nobody armed should never have fired. */
  enabled: z.boolean(),
  trigger: WorkflowTriggerSchema,
  /**
   * How far a cascade may go. An event-triggered workflow can cause the event it
   * listens for, and a counter is the difference between a loop that stops and one
   * that does not. 1 means "may fire, may not cause another firing".
   */
  maxDepth: z.number().int().min(0).max(5),
  steps: z.array(z.object({ recipeId: z.string(), recipeName: z.string(), orderIndex: z.number().int() })),
  lastFiredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

export const SaveWorkflowRequestSchema = z.object({
  name: z.string().min(1).max(120),
  trigger: WorkflowTriggerSchema,
  /** At least one: a workflow with no steps is a scheduled no-op. */
  recipeIds: z.array(z.string()).min(1).max(20),
  maxDepth: z.number().int().min(0).max(5).default(1),
  enabled: z.boolean().default(false),
});
export type SaveWorkflowRequest = z.infer<typeof SaveWorkflowRequestSchema>;

// ── what happened ──

export const WorkflowRunStatusSchema = z.enum(["running", "succeeded", "failed", "skipped"]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const WorkflowStepOutcomeSchema = z.object({
  recipeName: z.string(),
  /** The feature it created, when it got that far. */
  featureId: z.string().nullable(),
  /** How many steps were proposed and queued — the work now waiting for a human. */
  stepsQueued: z.number().int(),
  error: z.string().nullable(),
  /**
   * Why nothing needed doing. Distinct from `error` on purpose: a maintenance recipe that
   * correctly finds nothing is the system working, and the first real automated run
   * reported it as a failure because the two were conflated.
   */
  nothingNeeded: z.string().nullable().default(null),
});
export type WorkflowStepOutcome = z.infer<typeof WorkflowStepOutcomeSchema>;

export const WorkflowRunViewSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  triggeredBy: z.enum(["schedule", "event", "manual"]),
  depth: z.number().int(),
  status: WorkflowRunStatusSchema,
  /**
   * Why it did nothing, when it did nothing. An unattended run that silently skipped is
   * indistinguishable from one that never fired, which is the worst state for something
   * you are trusting to act without you.
   */
  skipReason: z.string().nullable(),
  outcomes: z.array(WorkflowStepOutcomeSchema),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type WorkflowRunView = z.infer<typeof WorkflowRunViewSchema>;

export const AutomationStateSchema = z.object({
  /**
   * One switch for all automation, separate from the dispatcher's pause. Pausing the
   * pipeline stops work running; this stops work being CREATED. They are different
   * questions and conflating them would make the safe action ambiguous.
   */
  paused: z.boolean(),
  recipes: z.number().int(),
  workflowsEnabled: z.number().int(),
  workflowsTotal: z.number().int(),
});
export type AutomationState = z.infer<typeof AutomationStateSchema>;

export const AutomationControlRequestSchema = z.object({ paused: z.boolean() });
export type AutomationControlRequest = z.infer<typeof AutomationControlRequestSchema>;
