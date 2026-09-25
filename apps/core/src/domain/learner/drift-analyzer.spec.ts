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

  it("flags the off-palette promo orange with evidence", () => {
    const f = analysis.findings.find((x) => x.kind === "off_palette_color" && x.hex === "#ff5722");
    expect(f).toBeTruthy();
    if (f?.kind !== "off_palette_color") return;
    expect(f.evidence[0]).toEqual({ file: "src/promo.tsx", line: 9 });
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
