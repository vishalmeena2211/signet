// Adapter events — everything the Claude Code worker stream can produce,
// zod-parsed at the boundary. The adapter yields these; the runtime persists
// them. Unknown stream lines become { type: "unrecognized" } rather than
// throwing: the stream format is another vendor's contract, we degrade loudly
// in telemetry instead of crashing a run.

import { z } from "zod";
import { SessionRefSchema } from "./ids.js";

export const ModelUsageSchema = z.object({
  model: z.string().min(1),
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const AdapterEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_started"), sessionRef: SessionRefSchema }),
  z.object({
    type: z.literal("tool_use"),
    toolName: z.string(),
    // Raw input intentionally opaque at this layer; specific tools are parsed
    // downstream by consumers that know their schemas.
    inputPreview: z.string().max(2000),
    /**
     * The few fields worth showing a person, lifted out BEFORE the preview is cut.
     * A Write's input is mostly file content, so the path can fall past the 2000-char
     * preview and a truncated JSON string cannot be parsed back anyway.
     */
    detail: z
      .object({
        filePath: z.string().optional(),
        command: z.string().max(500).optional(),
        description: z.string().max(300).optional(),
        pattern: z.string().max(300).optional(),
        todos: z
          .array(
            z.object({
              content: z.string(),
              status: z.enum(["pending", "in_progress", "completed"]),
              activeForm: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  }),
  z.object({ type: z.literal("assistant_text"), text: z.string() }),
  z.object({
    type: z.literal("usage_update"),
    perModel: z.array(ModelUsageSchema).min(1),
  }),
  z.object({
    type: z.literal("limit_reached"),
    limitKind: z.enum(["five_hour", "weekly", "overloaded", "rate", "unknown"]),
    resetsAt: z.iso.datetime().optional(),
    rawMessage: z.string(),
  }),
  z.object({
    type: z.literal("completed"),
    sessionRef: SessionRefSchema,
    resultText: z.string(),
    totalCostUsd: z.number().min(0).optional(),
    perModel: z.array(ModelUsageSchema),
    numTurns: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal("refusal"), rawMessage: z.string() }),
  z.object({
    type: z.literal("failed"),
    errorCode: z.string(),
    errorKind: z.enum(["recoverable", "non_recoverable", "conflict"]),
    rawMessage: z.string(),
  }),
  z.object({ type: z.literal("unrecognized"), rawLine: z.string().max(4000) }),
]);
export type AdapterEvent = z.infer<typeof AdapterEventSchema>;

export const AdapterAvailabilitySchema = z.object({
  installed: z.boolean(),
  version: z.string().optional(),
  authenticated: z.boolean(),
  binaryPath: z.string().optional(),
  problems: z.array(z.string()),
});
export type AdapterAvailability = z.infer<typeof AdapterAvailabilitySchema>;

export const IncrementPlanSchema = z.object({
  approach: z.string().min(1),
  filesToTouch: z.array(z.string().min(1)).min(1),
  risks: z.array(z.string()),
  // The mechanical scope check compares filesToTouch against the increment's
  // declared surface; anything outside becomes a question for the human.
  /**
   * Why a file outside the declared surface is needed, keyed by path. Optional: a plan
   * that stays inside has nothing to explain. When one does not, this is what the
   * person is shown — a reason they can judge, rather than a bare list of paths.
   */
  outsideReasons: z.record(z.string(), z.string()).optional(),
});
export type IncrementPlan = z.infer<typeof IncrementPlanSchema>;
