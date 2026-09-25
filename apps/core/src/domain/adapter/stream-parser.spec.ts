import { describe, expect, it } from "vitest";
import { parseStreamLine } from "./stream-parser.js";

const now = new Date("2026-09-25T14:00:00");

describe("stream parser", () => {
  it("captures the session ref from system/init", () => {
    const events = parseStreamLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc123" }),
      now,
    );
    expect(events).toEqual([{ type: "session_started", sessionRef: "sess-abc123" }]);
  });

  it("splits assistant content into text + tool_use events", () => {
    const events = parseStreamLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Editing the file now." },
            { type: "tool_use", name: "Edit", input: { file_path: "/x.ts" } },
          ],
        },
      }),
      now,
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "assistant_text", text: "Editing the file now." });
    expect(events[1]).toMatchObject({ type: "tool_use", toolName: "Edit" });
  });

  it("sums usage from the per-model ledger, never top-level usage", () => {
    const events = parseStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "s1",
        result: "done",
        total_cost_usd: 0.42,
        num_turns: 7,
        usage: { input_tokens: 10, output_tokens: 5 }, // main-loop-only — must be ignored
        modelUsage: {
          "claude-opus-5": { inputTokens: 900, outputTokens: 300, cacheReadInputTokens: 4000 },
          "claude-haiku-4-5": { inputTokens: 100, outputTokens: 50 },
        },
      }),
      now,
    );
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev).toMatchObject({ type: "completed", totalCostUsd: 0.42, numTurns: 7 });
    if (ev?.type !== "completed") return;
    expect(ev.perModel).toHaveLength(2);
    expect(ev.perModel[0]).toEqual({
      model: "claude-opus-5",
      inputTokens: 900,
      cachedInputTokens: 4000,
      outputTokens: 300,
    });
  });

  it("a clean-exit refusal is a refusal, never a success", () => {
    const events = parseStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "refusal",
        is_error: false,
        session_id: "s1",
        result: "I can't help with that.",
      }),
      now,
    );
    expect(events[0]?.type).toBe("refusal");
  });

  it("error_max_turns → recoverable failed event", () => {
    const events = parseStreamLine(
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "s1" }),
      now,
    );
    expect(events[0]).toMatchObject({
      type: "failed",
      errorCode: "adapter.max_turns",
      errorKind: "recoverable",
    });
  });

  it("a limit message inside an error result becomes limit_reached with reset time", () => {
    const events = parseStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "s1",
        result: "Claude usage limit reached ∙ resets 7:40pm",
      }),
      now,
    );
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.type).toBe("limit_reached");
    if (ev?.type !== "limit_reached") return;
    expect(new Date(ev.resetsAt ?? 0).getHours()).toBe(19);
  });

  it("non-JSON limit text on stderr-style lines still parses", () => {
    const events = parseStreamLine("You've hit your session limit · resets 7:40pm (Asia/Calcutta)", now);
    expect(events[0]?.type).toBe("limit_reached");
  });

  it("unknown JSON degrades to unrecognized, never throws", () => {
    const events = parseStreamLine(JSON.stringify({ type: "totally_new_thing", x: 1 }), now);
    expect(events[0]?.type).toBe("unrecognized");
  });

  it("blank lines produce nothing", () => {
    expect(parseStreamLine("   ", now)).toEqual([]);
  });

  // Fixture captured from the REAL CLI (2.1.281): is_error=true while
  // subtype="success", terminal_reason="api_error", auth expiry in result.
  it("real-world auth expiry: is_error with subtype success → non-recoverable auth_expired", () => {
    const events = parseStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        session_id: "f409b939-8031-40cf-ba56-9b24d30daace",
        total_cost_usd: 0,
        num_turns: 1,
        modelUsage: {},
        result: "Failed to authenticate: OAuth session expired and could not be refreshed",
      }),
      now,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "failed",
      errorCode: "adapter.auth_expired",
      errorKind: "non_recoverable",
    });
  });

  it("real-world api_error without auth text → adapter.api_error, recoverable", () => {
    const events = parseStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        session_id: "s2",
        result: "upstream 500",
      }),
      now,
    );
    expect(events[0]).toMatchObject({
      type: "failed",
      errorCode: "adapter.api_error",
      errorKind: "recoverable",
    });
  });
});
