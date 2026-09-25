// Turn drift findings into PROPOSED rule objects. Each finding kind maps to a
// human statement, an executable check (when enforceable), evidence, and a
// confidence seeded from severity + trend. Pure — the store persists them.

import { randomUUID } from "node:crypto";
import type { Rule, RuleCheck, RuleEvidence } from "@signet/contracts";
import { RuleIdSchema } from "@signet/contracts";
import type { DriftAnalysis, Finding } from "./drift-analyzer.js";

function id() {
  return RuleIdSchema.parse(randomUUID());
}

function confidenceFor(f: Finding): number {
  const base = f.severity === "high" ? 0.85 : f.severity === "medium" ? 0.6 : 0.4;
  return base;
}

export function findingToRule(f: Finding, brandHexes: string[]): Rule | null {
  switch (f.kind) {
    case "legacy_asset_conflict": {
      const evidence: RuleEvidence[] = [
        { ref: f.asset, kind: "asset", detail: `palette ${f.assetPalette.join(", ")}, ΔE ${f.distance} from brand` },
      ];
      const check: RuleCheck = { type: "forbid_asset", assetPath: f.asset };
      return rule(
        `Do not use the legacy asset ${f.asset} — its palette conflicts with the brand.`,
        "asset",
        evidence,
        confidenceFor(f),
        "dying",
        check,
        f.kind,
      );
    }
    case "off_palette_color": {
      const evidence: RuleEvidence[] = f.evidence.map((e) => ({ ref: `${e.file}:${e.line}`, kind: "usage" as const }));
      const check: RuleCheck = { type: "forbid_value", value: f.hex, allowContexts: [] };
      return rule(
        `Colour ${f.hex} is off-palette (nearest declared token is ${f.nearestDeclared ?? "none"}). Use a token instead.`,
        "color",
        evidence,
        confidenceFor(f),
        f.trend as Rule["trend"],
        check,
        f.kind,
      );
    }
    case "dying_value_still_present": {
      const evidence: RuleEvidence[] = [
        { ref: JSON.stringify(f.trendCounts), kind: "git-trend" },
        ...f.evidence.map((e) => ({ ref: `${e.file}:${e.line}`, kind: "usage" as const })),
      ];
      const check: RuleCheck = { type: "forbid_value", value: f.hex, allowContexts: [] };
      return rule(
        `Colour ${f.hex} is being migrated away — don't introduce new uses.`,
        "color",
        evidence,
        confidenceFor(f),
        "dying",
        check,
        f.kind,
      );
    }
    case "near_duplicate_colors": {
      const check: RuleCheck = {
        type: "palette_conformance",
        allowedHexes: [f.a, ...brandHexes],
        maxDeltaE: 3,
      };
      return rule(
        `${f.a} and ${f.b} are perceptually identical — consolidate to one token.`,
        "color",
        [{ ref: `${f.a} ≈ ${f.b}`, kind: "usage" }],
        confidenceFor(f),
        "unknown",
        check,
        f.kind,
      );
    }
    case "orphaned_asset": {
      // Advisory only — no reliable enforceable check (deletion is a human call).
      return rule(
        `Asset ${f.asset} is unreferenced — consider removing it.`,
        "asset",
        [{ ref: f.asset, kind: "asset" }],
        0.3,
        "unknown",
        null,
        f.kind,
      );
    }
    default:
      return null;
  }
}

function rule(
  statement: string,
  kind: Rule["kind"],
  evidence: RuleEvidence[],
  confidence: number,
  trend: Rule["trend"],
  check: RuleCheck | null,
  sourceFindingKind: string,
): Rule {
  return {
    id: id(),
    statement,
    kind,
    evidence,
    confidence,
    trend,
    status: "PROPOSED",
    check,
    exceptions: [],
    fpCount: 0,
    sourceFindingKind,
  };
}

export function proposalsFrom(analysis: DriftAnalysis): Rule[] {
  const brandHexes = analysis.brand ? [analysis.brand.canonicalHex] : [];
  return analysis.findings.map((f) => findingToRule(f, brandHexes)).filter((r): r is Rule => r !== null);
}
