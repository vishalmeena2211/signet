import { describe, expect, it } from "vitest";
import { detectLimit, extractResetTime, fallbackResetTime } from "./limit-parser.js";

describe("detectLimit", () => {
  const cases: Array<[string, string]> = [
    ["Claude usage limit reached ∙ resets 7:40pm", "unknown"],
    ["5-hour limit reached ∙ resets 2:00am", "five_hour"],
    ["5 hour limit reached", "five_hour"],
    ["Weekly limit reached · resets Monday", "weekly"],
    ["You've hit your usage limit", "unknown"],
    ["You’ve hit your session limit", "unknown"],
    ["rate_limit_error: too many requests", "rate"],
    ["HTTP 429 Too Many Requests", "rate"],
    ["overloaded_error", "overloaded"],
    ["Service unavailable (503), try again later", "overloaded"],
    ["out of extra usage", "unknown"],
  ];
  for (const [msg, kind] of cases) {
    it(`"${msg}" → ${kind}`, () => expect(detectLimit(msg)).toBe(kind));
  }
  it("ordinary output is not a limit", () => {
    expect(detectLimit("All 42 tests passed, limits of the design considered")).toBeNull();
    expect(detectLimit("increased the rate of polling")).toBeNull();
  });
});

describe("extractResetTime", () => {
  const now = new Date("2026-09-25T14:00:00");
  it("parses pm clock times later today", () => {
    const t = extractResetTime("Claude usage limit reached ∙ resets 7:40pm", now);
    expect(t?.getHours()).toBe(19);
    expect(t?.getMinutes()).toBe(40);
    expect(t?.getDate()).toBe(25);
  });
  it("rolls past times to tomorrow", () => {
    const t = extractResetTime("usage limit reached. resets 9:00am", now);
    expect(t?.getDate()).toBe(26);
    expect(t?.getHours()).toBe(9);
  });
  it("parses with timezone parenthetical", () => {
    const t = extractResetTime("You've hit your session limit · resets 7:40pm (Asia/Calcutta)", now);
    expect(t?.getHours()).toBe(19);
  });
  it("24h times", () => {
    const t = extractResetTime("limit reached, resets at 16:05", now);
    expect(t?.getHours()).toBe(16);
    expect(t?.getMinutes()).toBe(5);
  });
  it("returns null when unparseable", () => {
    expect(extractResetTime("Weekly limit reached · resets Monday", now)).toBeNull();
  });
});

describe("fallbackResetTime", () => {
  const now = new Date("2026-09-25T14:00:00");
  it("five_hour falls back to a 5h window", () => {
    expect(fallbackResetTime("five_hour", now).getTime() - now.getTime()).toBe(5 * 3600_000);
  });
  it("rate falls back to minutes, not hours", () => {
    expect(fallbackResetTime("rate", now).getTime() - now.getTime()).toBe(5 * 60_000);
  });
});
