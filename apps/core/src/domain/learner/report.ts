// Drift report renderer — markdown for humans (with a How-to-read legend),
// JSON for machines. Written OUTSIDE the target repo, always.

import type { DriftAnalysis } from "./drift-analyzer.js";

export function renderMarkdown(repoLabel: string, a: DriftAnalysis, generatedAt: Date): string {
  const lines: string[] = [];
  const p = (s = "") => lines.push(s);

  p(`# Signet design drift report — ${repoLabel}`);
  p();
  p(`Generated ${generatedAt.toISOString()} · source-only scan (no DOM), read-only.`);
  p();
  p(`## How to read this report`);
  p();
  p(`- **Palette** is what the code actually uses, clustered by perceptual similarity (ΔE) — not what anyone intended.`);
  p(`- **Trend** comes from git history at three points (now / 6 months / 12 months): a *dying* value is being migrated away by the team; enforcing it would reverse their own cleanup. *unknown* means not enough history.`);
  p(`- **Findings are proposals with evidence, not verdicts.** Each cites file:line or asset paths. Nothing here blocks anything.`);
  p(`- ΔE (perceptual distance): < 5 ≈ same color to the eye · > 25 ≈ clearly different family.`);
  p();
  p(`## Summary`);
  p();
  p(`| | |`);
  p(`| --- | --- |`);
  p(`| Files scanned | ${a.stats.scannedFiles} |`);
  p(`| Distinct color literals | ${a.stats.distinctColors} |`);
  p(`| Declared tokens | ${a.stats.declaredTokens} |`);
  p(`| Assets | ${a.stats.assets} |`);
  p(`| Findings | ${a.findings.length} (${a.findings.filter((f) => f.severity === "high").length} high) |`);
  p();

  if (a.brand) {
    p(`**Inferred primary brand color:** \`${a.brand.canonicalHex}\`` +
      (a.brand.declaredAs.length ? ` (declared as ${a.brand.declaredAs.map((d) => `\`${d}\``).join(", ")})` : "") +
      ` · ${a.brand.totalUses} uses · trend: ${a.brand.trend}`);
    p();
  }

  p(`## Palette (top clusters by use)`);
  p();
  p(`| Color | Uses | Declared as | Trend | Sample |`);
  p(`| --- | --- | --- | --- | --- |`);
  for (const cl of a.palette.slice(0, 15)) {
    const sample = cl.sampleEvidence[0];
    p(
      `| \`${cl.canonicalHex}\`${cl.members.length > 1 ? ` (+${cl.members.length - 1} variants)` : ""} | ${cl.totalUses} | ${
        cl.declaredAs.slice(0, 2).map((d) => `\`${d}\``).join(", ") || "—"
      } | ${cl.trend} | ${sample ? `${sample.file}:${sample.line}` : "—"} |`,
    );
  }
  p();

  p(`## Findings`);
  p();
  const icon = { high: "🔴", medium: "🟡", low: "⚪" } as const;
  for (const f of a.findings) {
    p(`### ${icon[f.severity]} ${f.kind.replace(/_/g, " ")}`);
    p();
    p(f.message);
    if ("evidence" in f && f.evidence.length > 0) {
      p();
      for (const e of f.evidence) p(`- \`${e.file}:${e.line}\``);
    }
    p();
  }
  if (a.findings.length === 0) p(`No drift found.`);

  return lines.join("\n") + "\n";
}
