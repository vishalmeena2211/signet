#!/usr/bin/env node
// signet learn — run the design-system learner against a repository.
//   node scripts/learn.mjs <repoPath> [outPathPrefix]
// Read-only on the target; report written OUTSIDE it (default: cwd).

import { basename, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { extractFromSource } from "../dist/domain/learner/source-extractor.js";
import { mineTrends } from "../dist/domain/learner/trend-miner.js";
import { analyzeDrift } from "../dist/domain/learner/drift-analyzer.js";
import { renderMarkdown } from "../dist/domain/learner/report.js";

const repo = process.argv[2];
if (!repo) {
  console.error("usage: node scripts/learn.mjs <repoPath> [outPathPrefix]");
  process.exit(1);
}
const repoPath = resolve(repo);
const label = basename(repoPath);
const outPrefix = process.argv[3] ?? `./signet-drift-report-${label}`;

const t0 = Date.now();
console.log(`[learn] scanning source of ${repoPath} …`);
const extraction = await extractFromSource(repoPath);
console.log(
  `[learn] ${extraction.scannedFiles} files · ${extraction.colors.length} color hits · ` +
    `${extraction.declaredTokens.length} declared tokens · ${extraction.assets.length} assets (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
);

// trend-mine the distinct chromatic values that matter (cap for speed)
const byHex = new Map();
for (const c of extraction.colors) byHex.set(c.hex, (byHex.get(c.hex) ?? 0) + 1);
const candidates = [...byHex.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 120)
  .map(([hex]) => hex);
console.log(`[learn] mining git trends for ${candidates.length} values …`);
const t1 = Date.now();
const trends = await mineTrends(repoPath, candidates);
console.log(`[learn] trends done (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

const analysis = analyzeDrift(extraction, trends);
const md = renderMarkdown(label, analysis, new Date());
await writeFile(`${outPrefix}.md`, md, "utf8");
await writeFile(`${outPrefix}.json`, JSON.stringify({ analysis, trends }, null, 1), "utf8");

const high = analysis.findings.filter((f) => f.severity === "high").length;
console.log(
  `[learn] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${analysis.findings.length} findings (${high} high)`,
);
console.log(`[learn] report: ${outPrefix}.md`);
