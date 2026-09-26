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

/**
 * How much the brand pick can be trusted. This is reported, not hidden, because
 * every palette finding rests on it — and a confident-sounding rule derived from a
 * guess is worse than no rule.
 *
 *   named        a token literally called brand/primary/accent. The team said it.
 *   declared     no such name, but a real palette of declared tokens exists and
 *                one leads on usage.
 *   none         there is no declared palette to reason from. NOT a licence to
 *                guess at the most common literal: on a utility-first codebase the
 *                colours live in class names, and the top literal is as likely to
 *                be a syntax-highlighting colour as a brand.
 */
export type BrandConfidence = "named" | "declared" | "none";

export interface DriftAnalysis {
  palette: PaletteCluster[];
  brand: PaletteCluster | null; // null when there is nothing to justify a pick
  brandConfidence: BrandConfidence;
  /** Plain-language reason, shown in the report so the conclusion is auditable. */
  brandReason: string;
  findings: Finding[];
  stats: { scannedFiles: number; distinctColors: number; declaredTokens: number; assets: number };
}

/**
 * At least one colour token must be declared in the codebase's own source before
 * any palette conclusion is drawn.
 *
 * One looks permissive, and it is — deliberately. The two things that actually
 * stop the nonsense are elsewhere: documentation and example files are excluded
 * from token extraction, and there is no longer a fallback to "the most common
 * literal" when nothing is declared. On tailwindcss.com those two together take
 * the declared count from one (`--color-clifford`, from an installation guide
 * teaching readers how to define a colour) to zero, which is the correct answer.
 *
 * Demanding a bigger palette instead would have broken the pilot, which declares
 * exactly one chromatic token — `--brand` — and is a perfectly good design system.
 * A team with one brand colour and a set of neutrals is not doing anything wrong.
 */
const MIN_DECLARED_FOR_PALETTE = 1;

/**
 * Paths whose colours are subject matter, not design decisions. A code sample in
 * the docs, a Storybook story, a test fixture and a changelog screenshot all
 * contain colours on purpose, and none of them is the team's palette.
 *
 * The same principle as the third-party asset exemption: content is not
 * convention.
 */
const ILLUSTRATIVE_PATH =
  /(?:^|\/)(?:docs?|documentation|examples?|demos?|fixtures?|__fixtures__|stories|storybook|__tests__|tests?|spec|specs|samples?|playground|sandbox|snapshots?|__snapshots__|node_modules|vendor|changelog)(?:\/|$)|\.(?:stories|story|spec|test)\.[jt]sx?$|\.mdx?$/i;

const CLUSTER_EPS = 10; // deltaE: members of one palette family
const NEAR_DUP_EPS = 5; // deltaE: should-be-identical
const FAR_FROM_PALETTE = 25; // deltaE: clearly foreign

/**
 * A colour used fewer times than this is a one-off, not a convention, and a rule
 * about it would gate on a single line someone wrote once. Conventions are things
 * a codebase does repeatedly — that is what makes them worth enforcing.
 */
const OFF_PALETTE_MIN_USES = 4;

/**
 * Assets that carry someone else's palette on purpose, and must never be reported
 * as drift. Framework and vendor marks, partner and payment badges, social icons,
 * flags, avatars, and anything living in a directory that announces it is
 * third-party. Run against the whole path, so `src/docs/img/guides/svelte.svg`
 * matches on the framework name and `assets/vendor/x.svg` matches on the folder.
 *
 * Getting this wrong is expensive in one direction only: a missed drift is one
 * rule you have to notice yourself, while a false one is a proposal you must
 * reject — and a queue full of rejections is a queue that stops being read.
 */
const THIRD_PARTY_ASSET =
  /(?:^|[/_.-])(?:vendor|vendors|third[_-]?party|external|partners?|brands?logos|social|flags?|avatars?|integrations?|guides?|frameworks?)(?:[/_.-]|$)|(?:^|[/_.-])(?:react|vue|svelte|angular|solid|qwik|astro|remix|nextjs|next|nuxt|rails|laravel|django|flask|phoenix|django|spring|dotnet|node|deno|bun|vite|webpack|rollup|esbuild|github|gitlab|bitbucket|google|apple|microsoft|amazon|aws|azure|gcp|slack|discord|twitter|x|facebook|meta|linkedin|youtube|figma|stripe|paypal|visa|mastercard|amex|npm|yarn|pnpm|docker|kubernetes|postgres|postgresql|mysql|mongodb|redis|typescript|javascript|python|ruby|golang|rust|php|java|swift|kotlin)(?:[_.-]|$)/i;

export function analyzeDrift(extraction: SourceExtraction, trends: ValueTrend[]): DriftAnalysis {
  const trendByHex = new Map(trends.map((t) => [t.value.toLowerCase(), t]));

  // aggregate usage per canonical hex (non-neutral only for palette work).
  // Illustrative files are excluded: a colour in a docs example or a Storybook
  // story is the subject of the page, not a decision the team made about its own
  // product.
  const usage = new Map<string, ColorUsage[]>();
  for (const c of extraction.colors) {
    if (ILLUSTRATIVE_PATH.test(c.file)) continue;
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

  // attach declared tokens to their clusters. A token declared inside a docs page
  // is teaching material — `--color-clifford` in Tailwind's install guide is the
  // literal example of this — so it is not treated as part of the palette.
  const declaredColorTokens = extraction.declaredTokens.filter(
    (t) => t.resolvedHex && !isNeutral(t.resolvedHex) && !ILLUSTRATIVE_PATH.test(t.file),
  );
  for (const t of declaredColorTokens) {
    const hex = t.resolvedHex ?? "";
    const host = clusters.find((cl) => deltaE(cl.canonicalHex, hex) < CLUSTER_EPS);
    if (host) {
      if (!host.declaredAs.includes(t.name)) host.declaredAs.push(t.name);
      continue;
    }
    // A declared token IS a palette member, whether or not its hex also appears
    // as a literal somewhere. Clusters were built from literal usage alone, so a
    // well-tokenized codebase — one that declares `--brand` once and then uses
    // `var(--brand)` everywhere — had its palette dropped on the floor. That is
    // exactly the codebase this product should understand best.
    clusters.push({
      canonicalHex: hex,
      members: [hex],
      totalUses: usage.get(hex)?.length ?? 0,
      declaredAs: [t.name],
      trend: trendByHex.get(hex)?.trend ?? "unknown",
      sampleEvidence: [{ file: t.file, line: t.line }],
    });
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

  // A palette needs more than one member to be a palette. Below the threshold
  // there is nothing to conform to, and the previous fallback — `clusters[0]`,
  // the most frequent literal — was a guess dressed as a finding: on a
  // utility-first codebase the colours live in class names, so the top literal is
  // as likely to be a syntax-highlighting colour as a brand.
  const hasPalette = declaredClusters.length >= MIN_DECLARED_FOR_PALETTE;
  const top = ranked[0];
  const brand = hasPalette ? (top ?? null) : null;
  const brandConfidence: BrandConfidence = !brand
    ? "none"
    : nameScore(brand) > 0
      ? "named"
      : "declared";
  const brandReason = brand
    ? brandConfidence === "named"
      ? `${brand.canonicalHex} is declared as ${brand.declaredAs.join(", ")} — the team named it.`
      : `${brand.canonicalHex} leads ${declaredClusters.length} declared tokens on usage, but nothing is named brand/primary/accent, so this is inferred rather than stated.`
    : declaredColorTokens.length === 0
      ? "No declared colour tokens outside documentation and examples. This codebase most likely expresses colour through utility classes, which this learner cannot read — so no palette conclusions are drawn."
      : `Only ${declaredColorTokens.length} declared colour token(s) found, which is not a palette. No palette conclusions are drawn.`;

  const findings: Finding[] = [];

  // legacy asset conflicts — the logo case
  if (brand) {
    for (const asset of extraction.assets) {
      const assetChromatic = asset.paletteHexes.filter((h) => !isNeutral(h));
      if (assetChromatic.length === 0) continue;

      // Identity assets (logos, brand marks) are held to a stricter standard:
      // a LOGO in a foreign palette is drift by definition, referenced or not.
      const isIdentityAsset = /logo|brand/i.test(asset.file);

      // A third-party mark is SUPPOSED to be off-brand. Framework logos, partner
      // badges, payment marks and social icons all carry someone else's palette
      // on purpose, so flagging them is pure noise.
      const isThirdPartyMark = THIRD_PARTY_ASSET.test(asset.file);

      // Which baseline depends on what the asset IS.
      //
      // A general asset is judged against the whole declared palette: an icon
      // drawn in the declared success green is not drift because the brand is
      // purple.
      //
      // An IDENTITY asset — a logo, a brand mark — is judged against the brand
      // alone. Judging it against the whole palette hides the exact case this
      // was built for: the pilot's legacy logo is navy and gold, and those are
      // still declared tokens because the migration to purple is unfinished. By
      // "is it near anything we declare?" the old logo looks fine. By "is it the
      // brand?" it is obviously stale, which is the truth.
      const baseline = isIdentityAsset ? [brand] : declaredClusters;
      const minDist = Math.min(
        ...assetChromatic.map((h) => Math.min(...baseline.map((d) => deltaE(h, d.canonicalHex)))),
      );
      if (minDist <= FAR_FROM_PALETTE) continue;
      const assetTrends = assetChromatic.map((h) => trendByHex.get(h)?.trend ?? "unknown");

      // Colours that are dying or gone in the history are real evidence. "unknown"
      // is NOT: an SVG's colours rarely appear as literals in source, so the trend
      // miner returns unknown for almost every asset. Treating that as evidence
      // meant every vendor logo on a documentation site became a proposal — 355 of
      // them on one repository, which is a queue nobody will ever review.
      const trendsAgainstIt =
        assetTrends.some((t) => t === "dying" || t === "gone") &&
        assetTrends.every((t) => t === "dying" || t === "gone" || t === "unknown");

      const suspicious = !isThirdPartyMark && (isIdentityAsset || trendsAgainstIt);
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

      // Positive evidence, or no proposal. Same principle as the asset case: an
      // unknown trend means the history told us nothing, not that the colour is
      // wrong. On a repository whose palette IS its subject matter — a docs site,
      // a component gallery — every colour is "off-palette" against whichever
      // token happened to rank first, and 140 such proposals bury the real ones.
      //
      // So a colour must EITHER be observably on the way out, OR be used enough
      // to be a convention rather than a one-off.
      const trendIsEvidence = cl.trend === "dying" || cl.trend === "gone";
      const usedLikeAConvention = cl.totalUses >= OFF_PALETTE_MIN_USES;
      if (!trendIsEvidence && !usedLikeAConvention) continue;

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

    // Never say this about the brand. This file's own comment records the pilot
    // lesson — a brand's LITERAL count falls as it gets tokenized, because uses
    // move from `#6609be` to `var(--brand)`. That is a healthy migration, and raw
    // frequency reads it as death. The finding fired on the real repository and
    // proposed "Colour #6609be is being migrated away" about the brand itself,
    // which is the most confidently wrong thing this learner could say.
    const isBrandMember = brand?.members.includes(t.value.toLowerCase()) ?? false;
    if (isBrandMember) continue;
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
    brandConfidence,
    brandReason,
    findings,
    stats: {
      scannedFiles: extraction.scannedFiles,
      distinctColors: usage.size,
      // Count what was actually used, not what was seen: documentation examples
      // are excluded above, and reporting the raw number would overstate how much
      // of a design system this codebase really declares.
      declaredTokens: declaredColorTokens.length,
      assets: extraction.assets.length,
    },
  };
}
