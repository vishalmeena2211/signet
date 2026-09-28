// Read models for the three places — Desk, Flow, Workshop — and a feature's thread.
// Each is shaped to what one screen draws, so the screen does no joining of its own.

import { z } from "zod";
import { FeatureIdSchema, IncrementIdSchema, RunIdSchema } from "./ids.js";

/** Whose seal and initials: the person at this machine, from their git identity. */
export const IdentitySchema = z.object({
  /** "V. Meena" — as it is written on a signature line. */
  signature: z.string(),
  /** "VM" — what the seal and the initials box carry. */
  initials: z.string(),
});
export type Identity = z.infer<typeof IdentitySchema>;

/** The six stages of work, counted. Two of them are yours. */
export const FlowCountsSchema = z.object({
  asked: z.number().int(),
  toInitial: z.number().int(),
  building: z.number().int(),
  checking: z.number().int(),
  toSeal: z.number().int(),
  landedToday: z.number().int(),
});
export type FlowCounts = z.infer<typeof FlowCountsSchema>;

export const StatusLineSchema = z.object({
  building: z.number().int(),
  spentTodayUsd: z.number().nullable(),
  /** Quota ran out: nothing builds until resetsAt. */
  held: z.object({ resetsAt: z.iso.datetime().nullable(), windowStart: z.iso.datetime().nullable(), queued: z.number().int() }).nullable(),
});
export type StatusLine = z.infer<typeof StatusLineSchema>;

export const DecisionSchema = z.object({
  kind: z.enum(["seal", "initial", "question", "failed"]),
  featureId: FeatureIdSchema,
  featureTitle: z.string(),
  incrementId: IncrementIdSchema,
  stepTitle: z.string(),
  /** Position among the feature's steps, 1-based, and how many there are. */
  stepIndex: z.number().int(),
  stepCount: z.number().int(),
  since: z.iso.datetime(),
  // seal
  files: z.number().int().nullable(),
  added: z.number().int().nullable(),
  removed: z.number().int().nullable(),
  proven: z.number().int().nullable(),
  promises: z.number().int().nullable(),
  repairs: z.number().int(),
  /** What the step has cost so far. */
  spentUsd: z.number().nullable(),
  // initial
  surface: z.array(z.string()),
  // question / failed
  text: z.string().nullable(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const DeskViewSchema = z.object({
  identity: IdentitySchema,
  repoLabel: z.string(),
  status: StatusLineSchema,
  flow: FlowCountsSchema,
  decisions: z.array(DecisionSchema),
  lastLandedAt: z.iso.datetime().nullable(),
});
export type DeskView = z.infer<typeof DeskViewSchema>;

// ── a feature, as one timeline ──

export const ThreadEventSchema = z.object({
  at: z.iso.datetime(),
  /** you — a person did it (solid). signet — Signet did it (hollow). ask — waiting on you. */
  who: z.enum(["you", "signet", "ask"]),
  title: z.string(),
  detail: z.string().nullable(),
  /** Mono lines under the detail: failing test output, for instance. */
  lines: z.array(z.string()),
  incrementId: IncrementIdSchema.nullable(),
});
export type ThreadEvent = z.infer<typeof ThreadEventSchema>;

export const ThreadStepSchema = z.object({
  id: IncrementIdSchema,
  title: z.string(),
  status: z.string(),
  /** What the step's line says under its title: "sealed", "building", "needs your initials". */
  said: z.string(),
  yours: z.boolean(),
  surface: z.array(z.string()),
  runId: RunIdSchema.nullable(),
  repairs: z.number().int(),
  /** A failed step that has not been dismissed yet, so the thread can offer to dismiss it. */
  dismissable: z.boolean(),
});
export type ThreadStep = z.infer<typeof ThreadStepSchema>;

export const NowSchema = z.object({
  incrementId: IncrementIdSchema,
  runId: RunIdSchema,
  stepIndex: z.number().int(),
  stepTitle: z.string(),
  phase: z.string(),
  /** Seven entries, one per phase: done, now, or not yet. */
  phases: z.array(z.enum(["d", "n", ""])),
  phaseEnteredAt: z.iso.datetime(),
  /** The file it is editing or reading right now, when known. */
  doing: z.string().nullable(),
  spentUsd: z.number().nullable(),
});
export type Now = z.infer<typeof NowSchema>;

export const ThreadViewSchema = z.object({
  featureId: FeatureIdSchema,
  title: z.string(),
  repoLabel: z.string(),
  events: z.array(ThreadEventSchema),
  steps: z.array(ThreadStepSchema),
  now: NowSchema.nullable(),
  spentUsd: z.number().nullable(),
  runs: z.number().int(),
  repairs: z.number().int(),
});
export type ThreadView = z.infer<typeof ThreadViewSchema>;

// ── flow: the canal, and the ledger ──

export const BoatSchema = z.object({
  title: z.string(),
  featureTitle: z.string(),
  featureId: FeatureIdSchema.nullable(),
  incrementId: IncrementIdSchema.nullable(),
  /** 0–100 for work in open water; null for work waiting at a gate. */
  progress: z.number().nullable(),
  /** "reading the repo", "repair 1", "checking", "waiting for your seal"… */
  note: z.string(),
  yours: z.boolean(),
});
export type Boat = z.infer<typeof BoatSchema>;

export const CanalViewSchema = z.object({
  planned: z.array(BoatSchema),
  building: z.array(BoatSchema),
  landed: z.array(BoatSchema),
  identity: IdentitySchema,
});
export type CanalView = z.infer<typeof CanalViewSchema>;

export const LedgerEntrySchema = z.object({
  incrementId: IncrementIdSchema,
  featureId: FeatureIdSchema,
  title: z.string(),
  featureTitle: z.string(),
  mergedAt: z.iso.datetime(),
  sha: z.string().nullable(),
  proven: z.number().int().nullable(),
  promises: z.number().int().nullable(),
  onTrust: z.number().int(),
  repairs: z.number().int(),
  costUsd: z.number().nullable(),
  record: z.object({
    askedAt: z.iso.datetime(),
    briefVersion: z.number().int(),
    answer: z.string().nullable(),
    initialledAt: z.iso.datetime().nullable(),
    runs: z.number().int(),
    buildMs: z.number().int().nullable(),
  }),
  /** Later merges in the same feature that would go with it if it were taken back. */
  builtOnTop: z.array(z.string()),
  /** Already taken back (a revert was merged), so it cannot be taken back again. */
  takenBack: z.boolean(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const LedgerViewSchema = z.object({ entries: z.array(LedgerEntrySchema), identity: IdentitySchema });
export type LedgerView = z.infer<typeof LedgerViewSchema>;

// ── a step, as the signing sheets need it ──

export const StepSheetSchema = z.object({
  incrementId: IncrementIdSchema,
  featureId: FeatureIdSchema,
  title: z.string(),
  featureTitle: z.string(),
  status: z.string(),
  stepIndex: z.number().int(),
  stepCount: z.number().int(),
  repoLabel: z.string(),
  repoPath: z.string(),
  base: z.string(),
  surface: z.array(z.string()),
  acceptance: z.string(),
  identity: IdentitySchema,
  /** Likely cost of building this step, from similar steps in this repo. Null without history. */
  likelyUsd: z.number().nullable(),
  likelySample: z.number().int(),
  spentUsd: z.number().nullable(),
  // seal
  builtAt: z.iso.datetime().nullable(),
  repairs: z.number().int(),
  files: z.number().int().nullable(),
  added: z.number().int().nullable(),
  removed: z.number().int().nullable(),
  /** Each check's latest outcome, in the order they are named. */
  checks: z.array(z.object({ gate: z.string(), outcome: z.string() })),
  briefVersion: z.number().int(),
  /** Answers given along the way, which the step was built with. */
  answers: z.array(z.string()),
  // sealed
  mergedAt: z.iso.datetime().nullable(),
  sha: z.string().nullable(),
  onTrust: z.array(z.string()),
  /** Already taken back: its revert has been sealed. */
  takenBack: z.boolean(),
  /** The next step of the same feature, and whether it is already initialled. */
  next: z.object({ title: z.string(), status: z.string() }).nullable(),
});
export type StepSheet = z.infer<typeof StepSheetSchema>;

export const CheckoutViewSchema = z.object({
  repoPath: z.string(),
  branch: z.string(),
  base: z.string(),
  onBase: z.boolean(),
});
export type CheckoutView = z.infer<typeof CheckoutViewSchema>;

// ── workshop: health ──

export const HealthLineSchema = z.object({
  label: z.string(),
  value: z.string(),
  ok: z.boolean(),
  /** For a failing line: what it prevents, and the command that fixes it. */
  problem: z.object({ title: z.string(), explain: z.string(), command: z.string().nullable() }).nullable(),
});
export type HealthLine = z.infer<typeof HealthLineSchema>;

export const HealthViewSchema = z.object({ lines: z.array(HealthLineSchema) });
export type HealthView = z.infer<typeof HealthViewSchema>;

// ── first run: the repo, as Signet read it ──

export const PortraitSchema = z.object({
  repoId: z.string(),
  label: z.string(),
  path: z.string(),
  /** The paragraph, as pieces: plain text and facts (underlined; `unsure` ones in the seal colour). */
  pieces: z.array(z.object({ text: z.string(), fact: z.boolean(), unsure: z.boolean() })),
  doubt: z.object({ question: z.string(), options: z.array(z.string()), suggested: z.number().int() }).nullable(),
  /** What the person said about it before, kept with the repo. */
  answered: z.string().nullable(),
  asks: z.array(z.string()),
});
export type Portrait = z.infer<typeof PortraitSchema>;
