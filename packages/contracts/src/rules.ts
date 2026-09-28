// The rule object — the unit of the design constitution. Mined as PROPOSED,
// promoted to CONFIRMED only by a human, auto-demoted when its false-positive
// count crosses threshold. A rule that can't compile to a check is advice, not
// a gate — so every enforceable rule carries a `check`.

import { z } from "zod";
import { RuleIdSchema } from "./ids.js";
import { RuleStatusSchema } from "./states.js";

export const RuleKindSchema = z.enum(["color", "asset", "token", "spacing", "typography"]);
export type RuleKind = z.infer<typeof RuleKindSchema>;

export const RuleEvidenceSchema = z.object({
  ref: z.string(), // "src/x.tsx:42" or "public/logo.svg" or a commit sha
  kind: z.enum(["usage", "declared", "asset", "git-trend", "review-comment", "fix-commit"]),
  detail: z.string().optional(),
});
export type RuleEvidence = z.infer<typeof RuleEvidenceSchema>;

// How a confirmed rule is mechanically enforced against a diff.
export const RuleCheckSchema = z.discriminatedUnion("type", [
  // forbid a specific literal value (e.g. a dying/off-palette color) in changed source
  z.object({ type: z.literal("forbid_value"), value: z.string(), allowContexts: z.array(z.string()).default([]) }),
  // forbid any chromatic color not within ΔE of an allowed set (token discipline)
  z.object({ type: z.literal("palette_conformance"), allowedHexes: z.array(z.string()), maxDeltaE: z.number() }),
  // forbid references to a legacy asset path
  z.object({ type: z.literal("forbid_asset"), assetPath: z.string() }),
]);
export type RuleCheck = z.infer<typeof RuleCheckSchema>;

export const RuleSchema = z.object({
  id: RuleIdSchema,
  statement: z.string().min(1), // human-readable: "Colour comes from tokens, never #010043"
  kind: RuleKindSchema,
  evidence: z.array(RuleEvidenceSchema),
  confidence: z.number().min(0).max(1),
  trend: z.enum(["new", "growing", "stable", "dying", "gone", "unknown"]),
  status: RuleStatusSchema,
  check: RuleCheckSchema.nullable(),
  exceptions: z
    .array(z.object({ path: z.string(), reason: z.string(), approvedBy: z.string() }))
    .default([]),
  fpCount: z.number().int().min(0).default(0),
  sourceFindingKind: z.string().optional(), // provenance from the drift analyzer
});
export type Rule = z.infer<typeof RuleSchema>;

// ── API shapes ──

export const RuleCardSchema = RuleSchema.pick({
  id: true,
  statement: true,
  kind: true,
  evidence: true,
  confidence: true,
  trend: true,
  status: true,
  fpCount: true,
  exceptions: true,
});
export type RuleCard = z.infer<typeof RuleCardSchema>;

export const EditRuleRequestSchema = z.object({
  statement: z.string().min(1).optional(),
  check: RuleCheckSchema.nullable().optional(),
});
export type EditRuleRequest = z.infer<typeof EditRuleRequestSchema>;

export const LearnRequestSchema = z.object({
  repoPath: z.string().min(1),
  label: z.string().optional(),
});
export type LearnRequest = z.infer<typeof LearnRequestSchema>;
