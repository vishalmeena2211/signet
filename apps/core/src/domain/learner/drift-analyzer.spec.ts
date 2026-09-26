import { describe, expect, it } from "vitest";
import { analyzeDrift } from "./drift-analyzer.js";
import { renderMarkdown } from "./report.js";
import type { SourceExtraction } from "./source-extractor.js";
import type { ValueTrend } from "./trend-miner.js";

// A synthetic replica of the pilot's shape: purple brand declared + used,
// legacy navy/gold living only inside an orphaned logo.svg.
const extraction: SourceExtraction = {
  root: "/x",
  scannedFiles: 40,
  colors: [
    ...Array.from({ length: 30 }, (_, i) => ({
      hex: "#6609be",
      alpha: 1,
      raw: "#6609be",
      file: `src/f${i}.tsx`,
      line: 1,
      context: "code" as const,
    })),
    { hex: "#010043", alpha: 1, raw: "#010043", file: "public/logo.svg", line: 1, context: "svg" as const },
    { hex: "#c8a05c", alpha: 1, raw: "#C8A05C", file: "public/logo.svg", line: 1, context: "svg" as const },
    { hex: "#ff5722", alpha: 1, raw: "#ff5722", file: "src/promo.tsx", line: 9, context: "code" as const },
    { hex: "#6a0bc1", alpha: 1, raw: "#6a0bc1", file: "src/almost.tsx", line: 3, context: "code" as const },
  ],
  declaredTokens: [
    { name: "--brand", value: "#6609be", resolvedHex: "#6609be", file: "src/globals.css", line: 2 },
    { name: "--grey-500", value: "#6b7280", resolvedHex: "#6b7280", file: "src/globals.css", line: 3 },
  ],
  assets: [
    {
      file: "public/logo.svg",
      kind: "svg",
      bytes: 900,
      references: 0,
      referencedFrom: [],
      paletteHexes: ["#010043", "#c8a05c"],
    },
    {
      file: "public/images/logo-new.png",
      kind: "png",
      bytes: 5000,
      references: 4,
      referencedFrom: ["src/Header.tsx"],
      paletteHexes: [],
    },
  ],
};

const trends: ValueTrend[] = [
  { value: "#6609be", counts: { now: 31, "6mo": 12, "12mo": 0 }, trend: "growing" },
  { value: "#010043", counts: { now: 2, "6mo": 6, "12mo": 14 }, trend: "dying" },
  { value: "#c8a05c", counts: { now: 2, "6mo": 4, "12mo": 9 }, trend: "dying" },
  { value: "#ff5722", counts: { now: 1, "6mo": 1 }, trend: "stable" },
];

describe("drift analyzer", () => {
  const analysis = analyzeDrift(extraction, trends);

  it("infers the purple brand from declared + trend + usage", () => {
    expect(analysis.brand?.canonicalHex).toBe("#6609be");
    expect(analysis.brand?.declaredAs).toContain("--brand");
  });

  it("THE ACCEPTANCE SHAPE: flags the legacy logo as a high-severity asset conflict", () => {
    const f = analysis.findings.find((x) => x.kind === "legacy_asset_conflict");
    expect(f).toBeTruthy();
    if (f?.kind !== "legacy_asset_conflict") return;
    expect(f.asset).toBe("public/logo.svg");
    expect(f.assetPalette.sort()).toEqual(["#010043", "#c8a05c"]);
    expect(f.severity).toBe("high");
    expect(f.distance).toBeGreaterThan(25);
    expect(f.assetTrends).toContain("dying");
  });

  it("does not flag the referenced on-brand png", () => {
    const conflicts = analysis.findings.filter((x) => x.kind === "legacy_asset_conflict");
    expect(conflicts).toHaveLength(1);
  });

  it("does NOT raise a gating rule for a colour used once", () => {
    // The promo orange appears a single time with a stable trend. A rule is a
    // standing law applied to every future change, and one occurrence is an
    // incident rather than a convention — so it does not belong in the queue.
    //
    // The case is not lost: it stays in the drift report, and the CONFORMANCE
    // gate covers it per-increment against an approved design of record, which
    // is exactly how this same colour was caught in the live demo. Two
    // instruments, two jobs.
    const f = analysis.findings.find((x) => x.kind === "off_palette_color" && x.hex === "#ff5722");
    expect(f).toBeUndefined();
  });

  it("DOES raise one for a colour used often enough to be a convention", () => {
    const repeated = analyzeDrift(
      {
        ...extraction,
        colors: [
          ...extraction.colors,
          ...Array.from({ length: 5 }, (_, i) => ({
            hex: "#00a3a3",
            alpha: 1,
            raw: "#00a3a3",
            file: `src/teal${i}.tsx`,
            line: 2,
            context: "code" as const,
          })),
        ],
      },
      trends,
    );
    const f = repeated.findings.find((x) => x.kind === "off_palette_color" && x.hex === "#00a3a3");
    expect(f).toBeTruthy();
    if (f?.kind !== "off_palette_color") return;
    expect(f.uses).toBeGreaterThanOrEqual(4);
  });

  it("near-duplicate purples cluster together rather than duplicating findings", () => {
    // #6a0bc1 is within ΔE<5 of #6609be → same cluster, so no near_duplicate finding
    const brandCluster = analysis.palette.find((c) => c.canonicalHex === "#6609be");
    expect(brandCluster?.members).toContain("#6a0bc1");
  });

  it("reports dying navy still present, high severity ordering holds", () => {
    const dying = analysis.findings.find((x) => x.kind === "dying_value_still_present" && x.hex === "#010043");
    expect(dying).toBeTruthy();
    expect(analysis.findings[0]?.severity).toBe("high");
  });

  it("renders a readable report with legend, brand, and the logo finding", () => {
    const md = renderMarkdown("fixture", analysis, new Date("2026-09-26T00:00:00Z"));
    expect(md).toContain("## How to read this report");
    expect(md).toContain("`#6609be`");
    expect(md).toContain("legacy asset conflict");
    expect(md).toContain("public/logo.svg");
  });
});

// Precision. A learner that proposes 355 near-identical rules has not found 355
// problems, it has produced a queue nobody will read — and the research this
// product is built on is explicit that rules die above roughly a 10% false
// positive rate. These pin the two ways that happened on a real repository.

describe("asset drift precision", () => {
  /** Minimal extraction with one brand colour and whatever assets a test needs. */
  function withAssets(assets: SourceExtraction["assets"]): SourceExtraction {
    return {
      root: "/x",
      scannedFiles: 10,
      colors: Array.from({ length: 20 }, (_, i) => ({
        hex: "#6609be",
        alpha: 1,
        raw: "#6609be",
        file: `src/f${i}.tsx`,
        line: 1,
        context: "code" as const,
      })),
      declaredTokens: [
        { name: "--brand", value: "#6609be", resolvedHex: "#6609be", file: "src/globals.css", line: 2 },
      ],
      assets,
    };
  }

  const offBrand = ["#ff3e00", "#40b3ff"]; // nothing like the purple brand
  const asset = (file: string, references = 3) => ({
    file,
    kind: "svg" as const,
    bytes: 800,
    references,
    referencedFrom: references > 0 ? ["src/Page.tsx"] : [],
    paletteHexes: offBrand,
  });

  const noTrendData: ValueTrend[] = [
    { value: "#6609be", counts: { now: 21, "6mo": 9, "12mo": 2 }, trend: "growing" },
  ];

  it("does NOT flag a third-party mark, which is off-brand on purpose", () => {
    // This is the exact shape that produced 355 proposals from one docs site:
    // a directory of framework logos, each legitimately carrying its own palette.
    const analysis = analyzeDrift(
      withAssets([
        asset("src/docs/img/guides/svelte.react.svg"),
        asset("src/docs/img/guides/rails.react.svg"),
        asset("src/docs/img/guides/phoenix.react.svg"),
        asset("assets/vendor/stripe.svg"),
        asset("public/social/twitter.svg"),
      ]),
      noTrendData,
    );
    expect(analysis.findings.filter((f) => f.kind === "legacy_asset_conflict")).toHaveLength(0);
  });

  it("does NOT treat an unknown trend as evidence against an asset", () => {
    // An SVG's colours rarely appear as literals in source, so the trend miner
    // returns "unknown" for almost every asset. Absence of evidence was being
    // read as evidence of absence, which is what made this fire on everything.
    const analysis = analyzeDrift(withAssets([asset("public/images/illustration-hero.svg")]), noTrendData);
    expect(analysis.findings.filter((f) => f.kind === "legacy_asset_conflict")).toHaveLength(0);
  });

  it("STILL flags an identity asset in a foreign palette — the case this exists for", () => {
    // The pilot's real finding must survive the precision work.
    const analysis = analyzeDrift(withAssets([asset("public/logo/logo.svg", 0)]), noTrendData);
    const found = analysis.findings.filter((f) => f.kind === "legacy_asset_conflict");
    expect(found).toHaveLength(1);
    expect(found[0]?.kind === "legacy_asset_conflict" && found[0].asset).toBe("public/logo/logo.svg");
  });

  it("STILL flags an asset whose colours are observably dying in the history", () => {
    const dying: ValueTrend[] = [
      ...noTrendData,
      { value: "#ff3e00", counts: { now: 1, "6mo": 8, "12mo": 20 }, trend: "dying" },
      { value: "#40b3ff", counts: { now: 0, "6mo": 3, "12mo": 11 }, trend: "gone" },
    ];
    const analysis = analyzeDrift(withAssets([asset("public/images/banner-old.svg")]), dying);
    expect(analysis.findings.filter((f) => f.kind === "legacy_asset_conflict")).toHaveLength(1);
  });

  it("does not let a vendor name inside a normal word trigger the exemption", () => {
    // "reaction" contains "react"; the boundary matters or the exemption becomes
    // a hole big enough to hide real drift in.
    const analysis = analyzeDrift(withAssets([asset("public/logo/reaction-logo.svg", 0)]), noTrendData);
    expect(analysis.findings.filter((f) => f.kind === "legacy_asset_conflict")).toHaveLength(1);
  });
});

// Knowing when NOT to conclude.
//
// On tailwindcss.com the extractor found exactly one declared colour token —
// `--color-clifford`, from a documentation page teaching readers how to define a
// colour — and the analyzer judged 1,360 colours against that example. Their real
// brand, #38bdf8, was reported as "off-palette", because on a utility-first
// codebase colour lives in class names this learner cannot read.
//
// The fix is not a cleverer guess. It is refusing to guess.

describe("brand inference confidence", () => {
  const base = (
    tokens: SourceExtraction["declaredTokens"],
    colors: SourceExtraction["colors"] = [],
  ): SourceExtraction => ({
    root: "/x",
    scannedFiles: 50,
    colors,
    declaredTokens: tokens,
    assets: [],
  });

  const token = (name: string, hex: string, file = "src/theme.css") => ({
    name,
    value: hex,
    resolvedHex: hex,
    file,
    line: 1,
  });

  it("says NONE when the only declared token comes from a documentation page", () => {
    // The literal tailwindcss.com case.
    const analysis = analyzeDrift(
      base([token("--color-clifford", "#da373d", "src/app/(docs)/docs/installation/page.tsx")]),
      [],
    );
    expect(analysis.brand).toBeNull();
    expect(analysis.brandConfidence).toBe("none");
    expect(analysis.brandReason).toMatch(/utility classes|not a palette|documentation/i);
    // And with no palette to conform to, it must not emit palette findings.
    expect(analysis.findings.filter((f) => f.kind === "off_palette_color")).toHaveLength(0);
  });

  it("says NONE rather than picking the most common literal", () => {
    // The old fallback was `clusters[0]` — the most frequent chromatic literal.
    // On a codebase with no declared palette that is a syntax-highlighting colour
    // as often as a brand, and it produced a confident rule from nothing.
    const analysis = analyzeDrift(
      base(
        [],
        Array.from({ length: 40 }, (_, i) => ({
          hex: "#f44250",
          alpha: 1,
          raw: "#f44250",
          file: `src/code-theme-${i}.ts`,
          line: 1,
          context: "code" as const,
        })),
      ),
      [],
    );
    expect(analysis.brand).toBeNull();
    expect(analysis.brandConfidence).toBe("none");
  });

  it("accepts a single declared token — one brand colour is a real design system", () => {
    // Demanding a larger palette would reject the pilot, which declares exactly
    // one chromatic token and is perfectly well-run. The protection against
    // nonsense is excluding documentation and refusing to guess from literals,
    // not insisting everyone have a big palette.
    const analysis = analyzeDrift(base([token("--brand", "#6609be")]), []);
    expect(analysis.brandConfidence).toBe("named");
    expect(analysis.brand?.canonicalHex).toBe("#6609be");
  });

  it("says NAMED when the team literally named the token", () => {
    const analysis = analyzeDrift(
      base([
        token("--brand-primary", "#6609be"),
        token("--success", "#12855c"),
        token("--warning", "#8a5a06"),
      ]),
      [],
    );
    expect(analysis.brandConfidence).toBe("named");
    expect(analysis.brand?.canonicalHex).toBe("#6609be");
    expect(analysis.brandReason).toMatch(/the team named it/i);
  });

  it("says DECLARED, and admits it is inferred, when no token is named brand", () => {
    const analysis = analyzeDrift(
      base(
        [token("--ink", "#6609be"), token("--leaf", "#12855c"), token("--sun", "#8a5a06")],
        Array.from({ length: 12 }, (_, i) => ({
          hex: "#6609be",
          alpha: 1,
          raw: "#6609be",
          file: `src/a${i}.tsx`,
          line: 1,
          context: "code" as const,
        })),
      ),
      [],
    );
    expect(analysis.brandConfidence).toBe("declared");
    expect(analysis.brandReason).toMatch(/inferred rather than stated/i);
  });

  it("ignores colours that only appear in stories, tests and fixtures", () => {
    const analysis = analyzeDrift(
      base(
        [token("--brand", "#6609be"), token("--b", "#12855c"), token("--c", "#8a5a06")],
        [
          ...Array.from({ length: 30 }, (_, i) => ({
            hex: "#ff00ff",
            alpha: 1,
            raw: "#ff00ff",
            file: `src/Button.stories.tsx`,
            line: i,
            context: "code" as const,
          })),
          ...Array.from({ length: 10 }, (_, i) => ({
            hex: "#6609be",
            alpha: 1,
            raw: "#6609be",
            file: `src/Real${i}.tsx`,
            line: 1,
            context: "code" as const,
          })),
        ],
      ),
      [],
    );
    // The magenta is the single most-used literal, and it is story furniture.
    expect(analysis.palette.some((c) => c.canonicalHex === "#ff00ff")).toBe(false);
    expect(analysis.brand?.canonicalHex).toBe("#6609be");
  });

  it("judges an asset against the WHOLE declared palette, not just the brand", () => {
    // An icon drawn in the declared success green is not drift because the brand
    // happens to be purple.
    const analysis = analyzeDrift(
      {
        ...base([
          token("--brand", "#6609be"),
          token("--success", "#12855c"),
          token("--warning", "#8a5a06"),
        ]),
        assets: [
          {
            file: "public/icons/state/success.svg",
            kind: "svg" as const,
            bytes: 400,
            references: 0,
            referencedFrom: [],
            paletteHexes: ["#12855c"],
          },
        ],
      },
      [],
    );
    expect(analysis.findings.filter((f) => f.kind === "legacy_asset_conflict")).toHaveLength(0);
  });
});

describe("the two regressions this fix caused, and must not cause again", () => {
  const tok = (name: string, hex: string) => ({ name, value: hex, resolvedHex: hex, file: "src/theme.css", line: 1 });

  it("judges an IDENTITY asset against the brand, not the whole palette", () => {
    // The pilot's legacy logo is navy and gold, and BOTH are still declared
    // tokens because the migration to purple is unfinished. Measured against
    // "anything we declare", the stale logo looks fine — which is how the
    // acceptance finding briefly disappeared. Measured against the brand, it is
    // obviously stale, which is the truth.
    const analysis = analyzeDrift(
      {
        root: "/x",
        scannedFiles: 20,
        colors: Array.from({ length: 20 }, (_, i) => ({
          hex: "#6609be",
          alpha: 1,
          raw: "#6609be",
          file: `src/a${i}.tsx`,
          line: 1,
          context: "code" as const,
        })),
        declaredTokens: [tok("--brand", "#6609be"), tok("--legacy-navy", "#100c28"), tok("--legacy-gold", "#c8a05c")],
        assets: [
          {
            file: "public/logo/logo.svg",
            kind: "svg" as const,
            bytes: 900,
            references: 0,
            referencedFrom: [],
            paletteHexes: ["#100c28", "#c8a05c"],
          },
        ],
      },
      [],
    );
    const found = analysis.findings.filter((f) => f.kind === "legacy_asset_conflict");
    expect(found).toHaveLength(1);
  });

  it("never says the BRAND is being migrated away", () => {
    // A brand's literal count falls as it gets tokenized — uses move from the hex
    // to var(--brand) — and raw frequency reads that healthy migration as death.
    // On the real repository this proposed "Colour #6609be is being migrated
    // away" about the brand itself.
    const analysis = analyzeDrift(
      {
        root: "/x",
        scannedFiles: 20,
        colors: [
          { hex: "#6609be", alpha: 1, raw: "#6609be", file: "src/globals.css", line: 2, context: "code" as const },
          { hex: "#227ae5", alpha: 1, raw: "#227ae5", file: "src/old.tsx", line: 4, context: "code" as const },
        ],
        declaredTokens: [tok("--brand-primary", "#6609be")],
        assets: [],
      },
      [
        { value: "#6609be", counts: { now: 1, "6mo": 9, "12mo": 22 }, trend: "dying" },
        { value: "#227ae5", counts: { now: 1, "6mo": 7, "12mo": 15 }, trend: "dying" },
      ],
    );
    const dying = analysis.findings.filter((f) => f.kind === "dying_value_still_present");
    expect(dying.map((f) => (f.kind === "dying_value_still_present" ? f.hex : ""))).toEqual(["#227ae5"]);
  });
});
