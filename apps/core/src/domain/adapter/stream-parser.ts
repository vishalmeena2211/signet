// Claude Code stream-json → AdapterEvent. Line-oriented; every line is another
// vendor's contract, so unknown shapes degrade to { type: "unrecognized" }
// (loud in telemetry) instead of crashing a run. Usage is summed per model
// from the result event's per-model ledger — NEVER the top-level usage, which
// reflects only the main-loop chain and silently hides subagent spend.

import { z } from "zod";
import {
  AdapterEventSchema,
  SessionRefSchema,
  type AdapterEvent,
  type ModelUsage,
} from "@signet/contracts";
import { detectLimit, extractResetTime, fallbackResetTime } from "./limit-parser.js";

// ── loose schemas for the vendor's lines (parse, don't assume) ──
const InitLine = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string().min(1),
});
const AssistantLine = z.object({
  type: z.literal("assistant"),
  message: z.object({
    content: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.literal("tool_use"), name: z.string(), input: z.unknown() }),
        z.object({ type: z.string() }).loose(),
      ]),
    ),
  }),
});
const ModelUsageEntry = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    cacheReadInputTokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
  })
  .loose();
const ResultLine = z
  .object({
    type: z.literal("result"),
    subtype: z.string().default("success"),
    session_id: z.string().min(1),
    result: z.string().optional(),
    is_error: z.boolean().default(false),
    // Real CLI observation: is_error may be true while subtype stays "success";
    // terminal_reason carries the honest classification then.
    terminal_reason: z.string().optional(),
    total_cost_usd: z.number().nonnegative().optional(),
    num_turns: z.number().int().nonnegative().optional(),
    modelUsage: z.record(z.string(), ModelUsageEntry).optional(),
    usage: ModelUsageEntry.optional(),
  })
  .loose();

function toModelUsage(model: string, u: z.infer<typeof ModelUsageEntry>): ModelUsage {
  return {
    model,
    inputTokens: u.inputTokens ?? u.input_tokens ?? 0,
    cachedInputTokens: u.cacheReadInputTokens ?? u.cache_read_input_tokens ?? 0,
    outputTokens: u.outputTokens ?? u.output_tokens ?? 0,
  };
}

/** Parse one stream-json line into zero or more AdapterEvents. */
export function parseStreamLine(rawLine: string, now: Date): AdapterEvent[] {
  const line = rawLine.trim();
  if (line === "") return [];

  let json: unknown;
  try {
    json = JSON.parse(line); // signet-policy-allow: raw-json-parse -- vendor stream boundary; every branch below re-validates through contracts schemas
  } catch {
    const limit = limitEventFromText(line, now);
    return limit ? [limit] : [validate({ type: "unrecognized", rawLine: line.slice(0, 4000) })];
  }

  const init = InitLine.safeParse(json);
  if (init.success) {
    return [
      validate({
        type: "session_started",
        sessionRef: SessionRefSchema.parse(init.data.session_id),
      }),
    ];
  }

  const assistant = AssistantLine.safeParse(json);
  if (assistant.success) {
    const events: AdapterEvent[] = [];
    for (const block of assistant.data.message.content) {
      if ("text" in block && typeof block.text === "string") {
        const limit = limitEventFromText(block.text, now);
        if (limit) events.push(limit);
        events.push(validate({ type: "assistant_text", text: block.text }));
      } else if (block.type === "tool_use" && "name" in block) {
        const input = "input" in block ? block.input : null;
        const detail = toolDetail(input);
        events.push(
          validate({
            type: "tool_use",
            toolName: String(block.name),
            inputPreview: JSON.stringify(input).slice(0, 2000),
            ...(detail ? { detail } : {}),
          }),
        );
      }
    }
    return events;
  }

  const result = ResultLine.safeParse(json);
  if (result.success) {
    const r = result.data;
    const perModel: ModelUsage[] = r.modelUsage
      ? Object.entries(r.modelUsage).map(([m, u]) => toModelUsage(m, u))
      : r.usage
        ? [toModelUsage("unknown", r.usage)]
        : [];

    if (r.is_error || r.subtype.startsWith("error")) {
      const raw = r.result ?? r.subtype;
      const limit = limitEventFromText(raw, now);
      if (limit) return [limit];
      if (/failed to authenticate|oauth session expired|authentication_failed/i.test(raw)) {
        // Only a human can refresh subscription auth — hard needs-you.
        return [
          validate({
            type: "failed",
            errorCode: "adapter.auth_expired",
            errorKind: "non_recoverable",
            rawMessage: raw,
          }),
        ];
      }
      if (r.subtype === "error_max_turns") {
        return [
          validate({
            type: "failed",
            errorCode: "adapter.max_turns",
            errorKind: "recoverable",
            rawMessage: raw,
          }),
        ];
      }
      // Prefer terminal_reason over a subtype that may still read "success".
      const reason = r.terminal_reason && r.terminal_reason !== "success" ? r.terminal_reason : r.subtype;
      return [
        validate({
          type: "failed",
          errorCode: `adapter.${reason && reason !== "success" ? reason : "error"}`,
          errorKind: "recoverable",
          rawMessage: raw,
        }),
      ];
    }
    // A policy refusal exits cleanly (is_error=false) — treat as its own outcome,
    // never as success (the failure mode that looks like success).
    if (r.subtype === "refusal" || r.subtype === "model_refusal") {
      return [validate({ type: "refusal", rawMessage: r.result ?? r.subtype })];
    }
    return [
      validate({
        type: "completed",
        sessionRef: SessionRefSchema.parse(r.session_id),
        resultText: r.result ?? "",
        ...(r.total_cost_usd !== undefined ? { totalCostUsd: r.total_cost_usd } : {}),
        perModel,
        ...(r.num_turns !== undefined ? { numTurns: r.num_turns } : {}),
      }),
    ];
  }

  return [validate({ type: "unrecognized", rawLine: line.slice(0, 4000) })];
}

// The fields a person watching would want, read from the FULL input. Every field is
// optional and independently validated: one odd field must not cost the others, and a
// tool this parser has never heard of simply yields nothing.
const ToolInput = z
  .object({
    file_path: z.string().optional(),
    notebook_path: z.string().optional(),
    path: z.string().optional(),
    command: z.string().optional(),
    description: z.string().optional(),
    pattern: z.string().optional(),
    todos: z.array(z.unknown()).optional(),
  })
  .loose();
const Todo = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().optional(),
});

type ToolDetail = NonNullable<Extract<AdapterEvent, { type: "tool_use" }>["detail"]>;

function toolDetail(input: unknown): ToolDetail | null {
  const parsed = ToolInput.safeParse(input);
  if (!parsed.success) return null;
  const i = parsed.data;
  const detail: ToolDetail = {};
  const filePath = i.file_path ?? i.notebook_path;
  if (filePath) detail.filePath = filePath;
  else if (i.path && i.pattern === undefined) detail.filePath = i.path;
  if (i.command) detail.command = i.command.slice(0, 500);
  if (i.description) detail.description = i.description.slice(0, 300);
  if (i.pattern) detail.pattern = i.pattern.slice(0, 300);
  if (i.todos) {
    const todos = i.todos.flatMap((t) => {
      const ok = Todo.safeParse(t);
      return ok.success ? [ok.data] : [];
    });
    if (todos.length > 0) detail.todos = todos;
  }
  return Object.keys(detail).length > 0 ? detail : null;
}

function limitEventFromText(text: string, now: Date): AdapterEvent | null {
  const kind = detectLimit(text);
  if (kind === null) return null;
  const resetsAt = extractResetTime(text, now) ?? fallbackResetTime(kind, now);
  return validate({
    type: "limit_reached",
    limitKind: kind,
    resetsAt: resetsAt.toISOString(),
    rawMessage: text.slice(0, 1000),
  });
}

function validate(candidate: AdapterEvent): AdapterEvent {
  return AdapterEventSchema.parse(candidate);
}
