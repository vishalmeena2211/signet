// Drift analyzer — combines the three source-tier signals into FINDINGS:
//   declared intent (custom-property tokens)  — what the team says
//   usage                                     — what the code does
//   trend (the derivative)                    — where the team is headed
// Every finding is a PROPOSAL with evidence; nothing here enforces anything.

import { deltaE, isNeutral } from "./color.js";
import type { SourceExtraction, ColorUsage } from "./source-extractor.js";
import type { ValueTrend } from "./trend-miner.js";

export interface PaletteCluster {
  canonicalHex: string; // most-used member
  members: string[]; // canonical hexes within deltaE threshold
  totalUses: number;
  declaredAs: string[]; // token names resolving into this cluster
  trend: string; // trend of the canonical member
  sampleEvidence: Array<{ file: string; line: number }>;
}

export type Finding =
  | {
      kind: "legacy_asset_conflict";
      severity: "high";
      asset: string;
      assetPalette: string[];
      references: number;
      brandHex: string;
      distance: number;
      assetTrends: string[];
      message: string;
    }
  | {
      kind: "off_palette_color";
      severity: "medium";
      hex: string;
      uses: number;
      nearestDeclared: string | null;
      distance: number | null;
      trend: string;
      evidence: Array<{ file: string; line: number }>;
      message: string;
    }
  | {
      kind: "near_duplicate_colors";
      severity: "low";
      a: string;
      b: string;
      distance: number;
      usesA: number;
      usesB: number;
      message: string;
    }
  | {
      kind: "dying_value_still_present";
      severity: "medium";
      hex: string;
      remaining: number;
      trendCounts: Record<string, number>;
      evidence: Array<{ file: string; line: number }>;
      message: string;
    }
  | {
      kind: "orphaned_asset";
      severity: "low";
      asset: string;
      bytes: number;
      message: string;
    };

export interface DriftAnalysis {
  palette: PaletteCluster[];
  brand: PaletteCluster | null; // best-guess primary brand cluster
  findings: Finding[];
  stats: { scannedFiles: number; distinctColors: number; declaredTokens: number; assets: number };
}

const CLUSTER_EPS = 10; // deltaE: members of one palette family
const NEAR_DUP_EPS = 5; // deltaE: should-be-identical
const FAR_FROM_PALETTE = 25; // deltaE: clearly foreign

export function analyzeDrift(extraction: SourceExtraction, trends: ValueTrend[]): DriftAnalysis {
  const trendByHex = new Map(trends.map((t) => [t.value.toLowerCase(), t]));

  // aggregate usage per canonical hex (non-neutral only for palette work)
  const usage = new Map<string, ColorUsage[]>();
  for (const c of extraction.colors) {
    const list = usage.get(c.hex) ?? [];
    list.push(c);
    usage.set(c.hex, list);
  }

  const chromatic = [...usage.entries()].filter(([hex]) => !isNeutral(hex));
  chromatic.sort((a, b) => b[1].length - a[1].length);

  // greedy clustering by perceptual distance
  const clusters: PaletteCluster[] = [];
  for (const [hex, uses] of chromatic) {
    const host = clusters.find((cl) => deltaE(cl.canonicalHex, hex) < CLUSTER_EPS);
    if (host) {
      host.members.push(hex);
      host.totalUses += uses.length;
      continue;
    }
    clusters.push({
      canonicalHex: hex,
      members: [hex],
      totalUses: uses.length,
      declaredAs: [],
      trend: trendByHex.get(hex)?.trend ?? "unknown",
      sampleEvidence: uses.slice(0, 3).map((u) => ({ file: u.file, line: u.line })),
    });
  }

  // attach declared tokens to their clusters
  const declaredColorTokens = extraction.declaredTokens.filter((t) => t.resolvedHex && !isNeutral(t.resolvedHex));
  for (const t of declaredColorTokens) {
    const hex = t.resolvedHex ?? "";
    const host = clusters.find((cl) => deltaE(cl.canonicalHex, hex) < CLUSTER_EPS);
    if (host && !host.declaredAs.includes(t.name)) host.declaredAs.push(t.name);
  }

  // brand pick — token-NAME semantics dominate: a token literally named
  // brand/primary/accent is the team saying "this is the brand", and that
  // outranks any literal count. (Pilot lesson: the brand's literal count
  // often FALLS as it gets tokenized — a healthy migration that raw
  // frequency+trend misreads as dying.)
  const declaredClusters = clusters.filter((c) => c.declaredAs.length > 0);
  const BRAND_NAME = /brand|primary|accent/i;
  const DEMOTED_NAME = /warning|error|success|danger|held|shadow|border|opacity|placeholder|document/i;
  const nameScore = (c: PaletteCluster): number => {
    let score = 0;
    for (const n of c.declaredAs) {
      if (BRAND_NAME.test(n)) score += 10;
      if (DEMOTED_NAME.test(n)) score -= 2;
    }
    return score;
  };
  const ranked = [...declaredClusters].sort(
    (a, b) => nameScore(b) - nameScore(a) || b.totalUses - a.totalUses,
  );
  const brand = ranked[0] ?? clusters[0] ?? null;

  const findings: Finding[] = [];

  // legacy asset conflicts — the logo case
  if (brand) {
    for (const asset of extraction.assets) {
      const assetChromatic = asset.paletteHexes.filter((h) => !isNeutral(h));
      if (assetChromatic.length === 0) continue;
      const minDist = Math.min(...assetChromatic.map((h) => deltaE(h, brand.canonicalHex)));
      if (minDist <= FAR_FROM_PALETTE) continue;
      const assetTrends = assetChromatic.map((h) => trendByHex.get(h)?.trend ?? "unknown");
      // Identity assets (logos, brand marks) are held to a stricter standard:
      // a LOGO in a foreign palette is drift by definition, referenced or not.
      const isIdentityAsset = /logo|brand/i.test(asset.file);
      const suspicious =
        isIdentityAsset ||
        asset.references === 0 ||
        assetTrends.every((t) => t === "dying" || t === "gone" || t === "unknown");
      if (!suspicious) continue;
      findings.push({
        kind: "legacy_asset_conflict",
        severity: "high",
        asset: asset.file,
        assetPalette: assetChromatic,
        references: asset.references,
        brandHex: brand.canonicalHex,
        distance: Math.round(minDist),
        assetTrends,
        message:
          `${asset.file} carries a palette (${assetChromatic.join(", ")}) far from the brand ` +
          `(${brand.canonicalHex}, ΔE ${Math.round(minDist)})` +
          (asset.references === 0 ? " and nothing references it" : "") +
          (assetTrends.some((t) => t === "dying" || t === "gone")
            ? "; its colors are dying/gone in source history"
            : "") +
          " — likely a legacy asset.",
      });
    }
  }

  // off-palette colors: used, chromatic, far from every declared cluster
  if (declaredClusters.length > 0) {
    for (const cl of clusters) {
      if (cl.declaredAs.length > 0) continue;
      const nearest = declaredClusters
        .map((d) => ({ d, dist: deltaE(cl.canonicalHex, d.canonicalHex) }))
        .sort((a, b) => a.dist - b.dist)[0];
      if (!nearest || nearest.dist <= FAR_FROM_PALETTE) continue;
      findings.push({
        kind: "off_palette_color",
        severity: "medium",
        hex: cl.canonicalHex,
        uses: cl.totalUses,
        nearestDeclared: nearest.d.canonicalHex,
        distance: Math.round(nearest.dist),
        trend: cl.trend,
        evidence: cl.sampleEvidence,
        message:
          `${cl.canonicalHex} (${cl.totalUses} uses, trend: ${cl.trend}) matches no declared token; ` +
          `nearest declared is ${nearest.d.canonicalHex} at ΔE ${Math.round(nearest.dist)}.`,
      });
    }
  }

  // near-duplicates across clusters
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i];
      const b = clusters[j];
      if (!a || !b) continue;
      const dist = deltaE(a.canonicalHex, b.canonicalHex);
      if (dist < NEAR_DUP_EPS) {
        findings.push({
          kind: "near_duplicate_colors",
          severity: "low",
          a: a.canonicalHex,
          b: b.canonicalHex,
          distance: Math.round(dist * 10) / 10,
          usesA: a.totalUses,
          usesB: b.totalUses,
          message: `${a.canonicalHex} and ${b.canonicalHex} are perceptually identical (ΔE ${dist.toFixed(1)}) — merge into one token.`,
        });
      }
    }
  }

  // dying values still present
  for (const t of trends) {
    if (t.trend !== "dying") continue;
    const uses = usage.get(t.value.toLowerCase());
    if (!uses || uses.length === 0) continue;
    findings.push({
      kind: "dying_value_still_present",
      severity: "medium",
      hex: t.value.toLowerCase(),
      remaining: uses.length,
      trendCounts: t.counts,
      evidence: uses.slice(0, 5).map((u) => ({ file: u.file, line: u.line })),
      message: `${t.value} is being migrated away (history: ${JSON.stringify(t.counts)}) but ${uses.length} uses remain.`,
    });
  }

  // orphaned assets (any kind, no chromatic requirement)
  for (const asset of extraction.assets) {
    if (asset.references > 0) continue;
    findings.push({
      kind: "orphaned_asset",
      severity: "low",
      asset: asset.file,
      bytes: asset.bytes,
      message: `${asset.file} is referenced by nothing in source.`,
    });
  }

  const severityRank = { high: 0, medium: 1, low: 2 } as const;
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return {
    palette: clusters.slice(0, 30),
    brand,
    findings,
    stats: {
      scannedFiles: extraction.scannedFiles,
      distinctColors: usage.size,
      declaredTokens: extraction.declaredTokens.length,
      assets: extraction.assets.length,
    },
  };
}
