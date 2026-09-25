// Trend miner — the derivative, not the level. For each candidate value we
// count occurrences at HEAD and at historical refs using `git grep <ref>`
// (reads the object store — no checkout, read-only by construction).
//
// A value heavily present a year ago and shrinking since is LEGACY BEING PAID
// DOWN — enforcing it would reverse the team's own cleanup. A value growing in
// recent history is CURRENT INTENT. Frequency alone cannot tell these apart;
// the derivative can.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export type TrendClass = "new" | "growing" | "stable" | "dying" | "gone" | "unknown";

export interface ValueTrend {
  value: string; // the literal searched (canonical hex etc.)
  counts: Record<string, number>; // refLabel -> occurrence count
  trend: TrendClass;
}

export interface TrendRef {
  label: string; // "now" | "6mo" | "12mo"
  ref: string; // resolved commit-ish
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await pexec("git", args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Resolve refs for now / months-ago snapshots; missing history degrades gracefully. */
export async function resolveTrendRefs(repo: string, monthsBack: number[] = [6, 12]): Promise<TrendRef[]> {
  const refs: TrendRef[] = [{ label: "now", ref: "HEAD" }];
  for (const months of monthsBack) {
    try {
      const out = (await git(repo, ["rev-list", "-1", `--before=${months} months ago`, "HEAD"])).trim();
      if (out) refs.push({ label: `${months}mo`, ref: out });
    } catch {
      /* shallow or young repo — skip */
    }
  }
  return refs;
}

function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Count occurrences of each value at each ref. Values are chunked into one
 * alternation per git-grep invocation; -i makes hex case-insensitive.
 */
export async function countAtRefs(
  repo: string,
  values: string[],
  refs: TrendRef[],
  pathGlobs: string[] = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.css", "*.scss", "*.svg", "*.html"],
): Promise<Map<string, Record<string, number>>> {
  const counts = new Map<string, Record<string, number>>();
  for (const v of values) counts.set(v, {});

  const CHUNK = 40;
  for (const { label, ref } of refs) {
    for (let i = 0; i < values.length; i += CHUNK) {
      const chunk = values.slice(i, i + CHUNK);
      const pattern = chunk.map(escapeRe).join("|");
      let out = "";
      try {
        out = await git(repo, [
          "grep",
          "-oiE",
          pattern,
          ref,
          "--",
          ...pathGlobs,
          ":!**/node_modules/**",
          ":!**/.worktrees/**",
          ":!**/dist/**",
        ]);
      } catch {
        // git grep exits 1 on zero matches — that's a valid zero, not an error
        out = "";
      }
      // output lines: <ref>:<path>:<match>
      for (const line of out.split("\n")) {
        if (!line) continue;
        const idx = line.lastIndexOf(":");
        if (idx === -1) continue;
        const match = line.slice(idx + 1).toLowerCase();
        const rec = counts.get(match) ?? counts.get(match.toLowerCase());
        if (rec) rec[label] = (rec[label] ?? 0) + 1;
      }
    }
  }
  return counts;
}

/** Classify the derivative across now / 6mo / 12mo counts. */
export function classifyTrend(counts: Record<string, number>): TrendClass {
  const now = counts["now"] ?? 0;
  const mid = counts["6mo"];
  const old = counts["12mo"];
  const past = mid ?? old;

  if (past === undefined) return "unknown"; // no history to compare
  if (now === 0 && past > 0) return "gone";
  if (now > 0 && past === 0) return "new";
  if (past === 0 && now === 0) return "unknown";

  const ratio = now / past;
  if (ratio >= 1.3) return "growing";
  if (ratio <= 0.7) return "dying";
  return "stable";
}

export async function mineTrends(repo: string, values: string[]): Promise<ValueTrend[]> {
  const refs = await resolveTrendRefs(repo);
  const counts = await countAtRefs(repo, values, refs);
  return values.map((v) => {
    const c = counts.get(v) ?? {};
    return { value: v, counts: c, trend: classifyTrend(c) };
  });
}
