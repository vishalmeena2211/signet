// Limit-message taxonomy for Claude Code subscription auth. Ported from the
// battle-tested pattern bank catalogued in research (production regexes that
// drive pause/resume in the wild), extended with reset-time extraction.
// Pure functions — no IO, fully tested.

export type LimitKind = "five_hour" | "weekly" | "overloaded" | "rate" | "unknown";

const FIVE_HOUR = /5[-\s]?hour\s+limit\s+reached/i;
const WEEKLY = /weekly\s+limit\s+reached/i;
const GENERIC_USAGE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+(?:\w+\s+)?limit|usage\s+limit\s+reached|usage\s+cap\s+reached|claude\s+usage\s+limit\s+reached|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage)/i;
const OVERLOADED =
  /(?:overloaded(?:_error)?|server\s+overloaded|service\s+unavailable|\b529\b|\b503\b|high\s+demand|temporarily\s+unavailable)/i;
const RATE =
  /(?:rate[-\s]?limit(?:ed)?|rate_limit_error|too\s+many\s+requests|\b429\b|throttl(?:ed|ing))/i;

/** Does this message indicate any limit/availability condition? */
export function detectLimit(message: string): LimitKind | null {
  if (FIVE_HOUR.test(message)) return "five_hour";
  if (WEEKLY.test(message)) return "weekly";
  if (GENERIC_USAGE.test(message)) return "unknown";
  if (RATE.test(message)) return "rate";
  if (OVERLOADED.test(message)) return "overloaded";
  return null;
}

const RESET_CLAUSE =
  /(?:resets?\s+(?:at\s+)?)([^\n()·∙]+?)(?:\s*\(([^)]+)\))?\s*(?:[.!]|\n|·|∙|$)/i;

/**
 * Extract a reset time from a limit message, resolved against `now`.
 * Handles "resets 7:40pm", "resets at 19:40", "resets 7:40pm (Asia/Calcutta)".
 * Returns null when no parseable clause exists — callers fall back to a
 * conservative default window.
 */
export function extractResetTime(message: string, now: Date): Date | null {
  const m = RESET_CLAUSE.exec(message);
  const raw = m?.[1]?.trim();
  if (!raw) return null;

  const t = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(raw);
  if (!t) return null;
  const hoursRaw = Number(t[1]);
  const minutes = Number(t[2]);
  const meridiem = t[3]?.toLowerCase();
  if (Number.isNaN(hoursRaw) || Number.isNaN(minutes) || minutes > 59) return null;

  let hours = hoursRaw;
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  if (hours > 23) return null;

  const candidate = new Date(now);
  candidate.setHours(hours, minutes, 0, 0);
  // A reset time that already passed today means tomorrow.
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/** Conservative fallback when a limit is detected but no reset time parses. */
export function fallbackResetTime(kind: LimitKind, now: Date): Date {
  const minutes =
    kind === "five_hour" ? 5 * 60 : kind === "weekly" ? 24 * 60 : kind === "rate" ? 5 : 15;
  return new Date(now.getTime() + minutes * 60_000);
}
