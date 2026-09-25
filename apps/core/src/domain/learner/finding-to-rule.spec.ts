import { describe, expect, it } from "vitest";
import { RuleSchema } from "@signet/contracts";
import { proposalsFrom } from "./finding-to-rule.js";
import type { DriftAnalysis } from "./drift-analyzer.js";

const analysis: DriftAnalysis = {
  palette: [],
  brand: {
    canonicalHex: "#6609be",
    members: ["#6609be"],
    totalUses: 40,
    declaredAs: ["--brand-primary"],
    trend: "growing",
    sampleEvidence: [],
  },
  findings: [
    {
      kind: "legacy_asset_conflict",
      severity: "high",
      asset: "public/logo/logo.svg",
      assetPalette: ["#010043", "#c8a05c"],
      references: 0,
      brandHex: "#6609be",
      distance: 59,
      assetTrends: ["dying", "dying"],
      message: "legacy logo",
    },
    {
      kind: "off_palette_color",
      severity: "medium",
      hex: "#ff5722",
      uses: 3,
      nearestDeclared: "#6609be",
      distance: 60,
      trend: "stable",
      evidence: [{ file: "src/promo.tsx", line: 9 }],
      message: "off palette",
    },
    { kind: "orphaned_asset", severity: "low", asset: "public/old.png", bytes: 100, message: "orphan" },
  ],
  stats: { scannedFiles: 1, distinctColors: 1, declaredTokens: 1, assets: 1 },
};

describe("finding → rule", () => {
  const rules = proposalsFrom(analysis);

  it("produces one valid PROPOSED rule per finding", () => {
    expect(rules).toHaveLength(3);
    for (const r of rules) {
      expect(() => RuleSchema.parse(r)).not.toThrow();
      expect(r.status).toBe("PROPOSED");
    }
  });

  it("the legacy logo becomes a forbid_asset check with high confidence", () => {
    const logo = rules.find((r) => r.sourceFindingKind === "legacy_asset_conflict");
    expect(logo?.check).toEqual({ type: "forbid_asset", assetPath: "public/logo/logo.svg" });
    expect(logo?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(logo?.evidence[0]?.kind).toBe("asset");
  });

  it("off-palette color becomes a forbid_value check carrying file:line evidence", () => {
    const c = rules.find((r) => r.sourceFindingKind === "off_palette_color");
    expect(c?.check).toEqual({ type: "forbid_value", value: "#ff5722", allowContexts: [] });
    expect(c?.evidence[0]?.ref).toBe("src/promo.tsx:9");
  });

  it("orphaned asset is advisory — no enforceable check", () => {
    const o = rules.find((r) => r.sourceFindingKind === "orphaned_asset");
    expect(o?.check).toBeNull();
  });
});
