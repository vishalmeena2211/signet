// Trend miner tested against a real fixture git repo with a STAGED MIGRATION:
// old commits use #010043 heavily; recent commits replace it with #6609be.
// The miner must call the old color dying and the new one growing — from
// history alone, with backdated commits.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyTrend, countAtRefs, mineTrends, resolveTrendRefs } from "./trend-miner.js";

const pexec = promisify(execFile);
let repo: string;

async function commitAt(dateIso: string, message: string) {
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: dateIso,
    GIT_COMMITTER_DATE: dateIso,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  await pexec("git", ["add", "-A"], { cwd: repo, env });
  await pexec("git", ["commit", "-m", message], { cwd: repo, env });
}

function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "signet-trend-"));
  await pexec("git", ["init", "-b", "main"], { cwd: repo });

  // 14 months ago: legacy navy everywhere
  await writeFile(join(repo, "a.css"), `.x{color:#010043}.y{background:#010043}.z{border-color:#010043}\n`);
  await writeFile(join(repo, "b.tsx"), `export const B = () => <div style={{ color: "#010043" }} />;\n`);
  await commitAt(monthsAgoIso(14), "legacy styling");

  // 7 months ago: migration begins — some navy replaced by purple
  await writeFile(join(repo, "a.css"), `.x{color:#6609be}.y{background:#010043}.z{border-color:#010043}\n`);
  await commitAt(monthsAgoIso(7), "start brand migration");

  // recent: migration nearly done — one navy left, purple grown
  await writeFile(join(repo, "a.css"), `.x{color:#6609be}.y{background:#6609be}.z{border-color:#6609be}\n`);
  await writeFile(join(repo, "b.tsx"), `export const B = () => <div style={{ color: "#6609be" }} />;\n`);
  await writeFile(join(repo, "c.tsx"), `export const C = () => <div style={{ color: "#6609be" }} />;\n`);
  await commitAt(monthsAgoIso(0.1), "finish brand migration (almost)");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("trend refs", () => {
  it("resolves now + 6mo + 12mo snapshots on a repo with history", async () => {
    const refs = await resolveTrendRefs(repo);
    expect(refs.map((r) => r.label)).toEqual(["now", "6mo", "12mo"]);
  });
});

describe("staged migration is read correctly from history", () => {
  it("navy is dying, purple is growing — the derivative disagrees with raw frequency", async () => {
    const trends = await mineTrends(repo, ["#010043", "#6609be"]);
    const navy = trends.find((t) => t.value === "#010043");
    const purple = trends.find((t) => t.value === "#6609be");

    expect(navy?.counts["12mo"]).toBe(4); // dominant a year ago
    expect(navy?.counts["now"] ?? 0).toBe(0); // gone at HEAD
    expect(navy?.trend).toBe("gone");

    expect(purple?.counts["12mo"] ?? 0).toBe(0);
    expect(purple?.counts["now"]).toBe(5);
    // At the 6mo snapshot the migration had begun (count 1) — so purple is
    // "growing" (5x since), not "new". The derivative is honest about when
    // adoption actually started.
    expect(purple?.trend).toBe("growing");
  });

  it("counts at the mid ref capture the migration midpoint", async () => {
    const refs = await resolveTrendRefs(repo);
    const counts = await countAtRefs(repo, ["#010043", "#6609be"], refs);
    expect(counts.get("#010043")?.["6mo"]).toBe(3);
    expect(counts.get("#6609be")?.["6mo"]).toBe(1);
  });
});

describe("classification boundaries", () => {
  it("ratios drive growing/stable/dying; missing history is unknown", () => {
    expect(classifyTrend({ now: 13, "6mo": 10 })).toBe("growing");
    expect(classifyTrend({ now: 10, "6mo": 10 })).toBe("stable");
    expect(classifyTrend({ now: 6, "6mo": 10 })).toBe("dying");
    expect(classifyTrend({ now: 5 })).toBe("unknown");
    expect(classifyTrend({ now: 0, "6mo": 8 })).toBe("gone");
    expect(classifyTrend({ now: 8, "6mo": 0 })).toBe("new");
  });
});
