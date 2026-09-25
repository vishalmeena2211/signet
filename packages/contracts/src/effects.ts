// Effect journal shapes — log-before-act. Every external effect is journaled
// with an idempotency key BEFORE execution, in the same transaction as the
// state change that motivates it. Recovery replays from here.

import { z } from "zod";
import { EffectIdSchema, RunIdSchema } from "./ids.js";
import { RunPhaseNameSchema } from "./states.js";

export const EffectKindSchema = z.enum([
  "git_worktree_create",
  "git_worktree_remove",
  "git_commit",
  "git_branch_push",
  "pr_open",
  "pr_comment",
  "agent_spawn",
  "notification_send",
]);
export type EffectKind = z.infer<typeof EffectKindSchema>;

export const EffectStatusSchema = z.enum(["JOURNALED", "EXECUTING", "DONE", "FAILED"]);
export type EffectStatus = z.infer<typeof EffectStatusSchema>;

export const EffectRecordSchema = z.object({
  id: EffectIdSchema,
  runId: RunIdSchema,
  phase: RunPhaseNameSchema,
  kind: EffectKindSchema,
  // Deterministic key: `${runId}:${phase}:${kind}:${discriminator}` — retries
  // reuse it, so downstream systems (git, GitHub) can dedupe.
  idempotencyKey: z.string().min(1),
  status: EffectStatusSchema,
  payloadJson: z.string(), // schema-validated by the executor for its kind
  resultJson: z.string().optional(),
  attempt: z.number().int().min(1),
});
export type EffectRecord = z.infer<typeof EffectRecordSchema>;

export const OutboxMessageSchema = z.object({
  id: z.string().min(1),
  topic: z.enum(["run.dispatch", "run.resume", "gate.execute", "notify"]),
  payloadJson: z.string(),
  availableAt: z.iso.datetime(), // for parked/delayed work (quota resume)
});
export type OutboxMessage = z.infer<typeof OutboxMessageSchema>;
