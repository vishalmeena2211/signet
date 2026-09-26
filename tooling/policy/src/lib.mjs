// Shared helpers for policy checks. Node built-ins only — the policy suite
// must run before dependencies are installed cleanly.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Directories whose contents are not ours to police.
//
// "generated" carries its weight: the Prisma client is emitted into
// apps/core/src/persistence/generated, and it contains `any` and raw JSON.parse
// by design. Scanning it produced 54 violations in code nobody wrote and nobody
// can fix.
//
// It was also a CACHE CORRECTNESS bug, which is why it went unnoticed. That
// directory is gitignored, turbo's default cache key is tracked files, and the
// policy task read it anyway — so the task's result depended on inputs the cache
// could not see, and a stale pass replayed indefinitely. Not reading untracked
// files is what makes the cached result trustworthy again.
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  "coverage",
  ".next",
  "generated",
]);

/** Recursively list files under `dir` (absolute), filtered by extension list. */
export async function listFiles(dir, exts) {
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(join(d, e.name));
      } else if (exts.some((x) => e.name.endsWith(x))) {
        out.push(join(d, e.name));
      }
    }
  }
  await walk(dir);
  return out;
}

export async function readText(file) {
  return readFile(file, "utf8");
}

export function rel(file) {
  return relative(repoRoot, file);
}

/**
 * Returns line numbers (1-based) in `text` matching `pattern`, skipping lines
 * that carry an explicit, reasoned allow comment for `checkId`:
 *   // signet-policy-allow: <checkId> -- <reason>
 */
export function violatingLines(text, pattern, checkId) {
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (!pattern.test(line)) continue;
    const allowRe = new RegExp(`signet-policy-allow:\\s*${checkId}\\s*--\\s*\\S`);
    if (allowRe.test(line) || (i > 0 && allowRe.test(lines[i - 1] ?? ""))) continue;
    hits.push(i + 1);
  }
  return hits;
}
