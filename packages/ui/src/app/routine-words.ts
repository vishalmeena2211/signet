// How a routine is said in words: shared by the sentence view and the canvas.

import type { WorkflowTrigger } from "@signet/contracts";

export const EVENT_WORDS: Record<string, string> = {
  step_merged: "a step lands",
  run_failed: "a run fails",
  rules_proposed: "new conventions are found",
  quota_reset: "the Claude quota comes back",
};

/**
 * Events a routine's own work can cause, so a routine they start can start itself: its
 * work can fail, and it spends quota that later comes back. A step landing cannot, since
 * only a person seals; nor can conventions being found, which follows a person's seal.
 */
export const SELF_CAUSED = new Set(["run_failed", "quota_reset"]);

export function hm(h: number, m: number): string {
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** The trigger, as the opening of a sentence: [prefix, slot]. */
export function triggerWords(t: WorkflowTrigger): [string, string] {
  switch (t.kind) {
    case "schedule": {
      if (t.every === "hour") return ["Every", "hour"];
      const part = t.atHour < 6 || t.atHour >= 21 ? "night" : t.atHour < 12 ? "morning" : t.atHour < 18 ? "afternoon" : "evening";
      if (t.every === "day") return ["Every", `${part} at ${hm(t.atHour, t.atMinute)}`];
      const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][t.onWeekday] ?? "Monday";
      return ["Every", `${day} at ${hm(t.atHour, t.atMinute)}`];
    }
    case "event":
      return ["When", EVENT_WORDS[t.event] ?? t.event];
    case "manual":
      return ["When", "I say so"];
  }
}

export function lowerFirst(s: string): string {
  return s ? (s[0]?.toLowerCase() ?? "") + s.slice(1) : s;
}
