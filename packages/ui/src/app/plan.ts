// A proposed plan while it is on screen: the rules for reshaping it by hand. Pure, so
// the drag and drop only says what was dropped where, and the rules are testable.

import type { Doubt, ProposedStep } from "@signet/contracts";

export interface DraftStep {
  title: string;
  rationale: string;
  surface: string[];
  /** One promise per entry — the unit a step is cut between. */
  promises: string[];
  doubts: Doubt[];
  /** The option picked for each doubt; starts at its suggestion. */
  picks: Array<number | null>;
}

export function promisesOf(acceptanceMd: string): string[] {
  const lines = acceptanceMd.split("\n").map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^(?:[-*•]|\d+[.)])\s+/.test(l));
  const source = bullets.length > 0 ? bullets : lines;
  return source.map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1"));
}

export function toDraft(s: ProposedStep): DraftStep {
  return {
    title: s.title,
    rationale: s.rationale,
    surface: [...s.declaredSurface],
    promises: promisesOf(s.acceptanceMd),
    doubts: s.doubts,
    picks: s.doubts.map((d) => d.suggested),
  };
}

export function acceptanceOf(d: DraftStep): string {
  return d.promises.map((p) => `- ${p}`).join("\n");
}

/** Moves one file from one step's fence to another's. */
export function moveFile(steps: readonly DraftStep[], from: number, to: number, file: string): DraftStep[] {
  if (from === to || !steps[from] || !steps[to] || !steps[from].surface.includes(file)) return [...steps];
  return steps.map((s, i) =>
    i === from ? { ...s, surface: s.surface.filter((f) => f !== file) } : i === to ? { ...s, surface: [...new Set([...s.surface, file])] } : s,
  );
}

export function moveStep(steps: readonly DraftStep[], from: number, to: number): DraftStep[] {
  const out = [...steps];
  const [s] = out.splice(from, 1);
  if (!s) return [...steps];
  out.splice(Math.max(0, Math.min(to, out.length)), 0, s);
  return out;
}

/** Cuts step `index` before promise `at`; the rest becomes its own step right after. */
export function splitStep(steps: readonly DraftStep[], index: number, at: number): DraftStep[] {
  const s = steps[index];
  if (!s || at <= 0 || at >= s.promises.length) return [...steps];
  const first = { ...s, promises: s.promises.slice(0, at) };
  const second: DraftStep = { title: `${s.title} (continued)`, rationale: "Split by you.", surface: [...s.surface], promises: s.promises.slice(at), doubts: [], picks: [] };
  return [...steps.slice(0, index), first, second, ...steps.slice(index + 1)];
}

/** Replaces one fence entry with another — the one-click fix for a fence that matches nothing. */
export function replaceFile(steps: readonly DraftStep[], pattern: string, withPath: string): DraftStep[] {
  return steps.map((s) => (s.surface.includes(pattern) ? { ...s, surface: [...new Set(s.surface.map((f) => (f === pattern ? withPath : f)))] } : s));
}
