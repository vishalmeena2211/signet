import { describe, expect, it } from "vitest";
import { RuleSchema } from "@signet/contracts";
import { proposalsFrom } from "./finding-to-rule.js";
import type { DriftAnalysis } from "./drift-analyzer.js";

const analysis: DriftAnalysis = {
  palette: [],
  brandConfidence: "named" as const,
  brandReason: "declared as --brand",
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

  it("produces a valid PROPOSED rule for every finding that can gate", () => {
    // Not one rule per finding: a finding with no enforceable check is an
    // observation for the report, not an item for the confirmation queue.
    expect(rules).toHaveLength(2);
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

  it("orphaned asset produces NO rule at all — advice is not a gate", () => {
    // It used to become a rule with a null check: 127 items of triage on one real
    // repository that could never gate anything, and mostly wrong anyway, since
    // static reference-counting cannot see a dynamic import or an MDX reference.
    expect(rules.find((r) => r.sourceFindingKind === "orphaned_asset")).toBeUndefined();
    // And every rule that DOES reach the queue carries a check it can enforce.
    for (const r of rules) expect(r.check).not.toBeNull();
  });
});
