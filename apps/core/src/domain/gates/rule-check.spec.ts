import { describe, expect, it } from "vitest";
import { RuleIdSchema, type Rule } from "@signet/contracts";
import { parseAddedLines, runRuleCheck, type DiffLine } from "./rule-check.js";

function rule(check: Rule["check"], exceptions: Rule["exceptions"] = []): Rule {
  return {
    id: RuleIdSchema.parse("11111111-aaaa-4bbb-8ccc-000000000abc"),
    statement: "test rule",
    kind: "color",
    evidence: [],
    confidence: 0.9,
    trend: "dying",
    status: "CONFIRMED",
    check,
    exceptions,
    fpCount: 0,
  };
}

describe("diff parsing", () => {
  it("extracts added lines with correct new-file line numbers, ignoring removals", () => {
    const diff = `diff --git a/x.tsx b/x.tsx
--- a/x.tsx
+++ b/x.tsx
@@ -10,2 +10,3 @@
 context line
-const old = "#010043";
+const neu = "#6609be";
+const two = "#ff0000";
`;
    const added = parseAddedLines(diff);
    expect(added).toEqual([
      { file: "x.tsx", line: 11, text: 'const neu = "#6609be";' },
      { file: "x.tsx", line: 12, text: 'const two = "#ff0000";' },
    ]);
  });
});

describe("forbid_value", () => {
  const r = rule({ type: "forbid_value", value: "#010043", allowContexts: [] });

  it("flags a NEW use of the forbidden color", () => {
    const added: DiffLine[] = [{ file: "a.css", line: 5, text: ".x { color: #010043; }" }];
    const v = runRuleCheck(r, added);
    expect(v).toHaveLength(1);
    expect(v[0]?.file).toBe("a.css");
    expect(v[0]?.line).toBe(5);
  });

  it("GRANDFATHERING: pre-existing uses (not in the diff) are never inspected", () => {
    // Only added lines are passed in — the legacy backlog simply isn't here.
    const v = runRuleCheck(r, []);
    expect(v).toHaveLength(0);
  });

  it("matches across formats (rgb form of the same color)", () => {
    const added: DiffLine[] = [{ file: "a.css", line: 1, text: "color: rgb(1, 0, 67)" }];
    expect(runRuleCheck(r, added)).toHaveLength(1);
  });

  it("respects path exceptions", () => {
    const rx = rule({ type: "forbid_value", value: "#010043", allowContexts: [] }, [
      { path: "src/legacy/", reason: "legacy area", approvedBy: "vishal" },
    ]);
    const added: DiffLine[] = [{ file: "src/legacy/old.css", line: 1, text: "color: #010043" }];
    expect(runRuleCheck(rx, added)).toHaveLength(0);
  });
});

describe("forbid_asset", () => {
  const r = rule({ type: "forbid_asset", assetPath: "public/logo/logo.svg" });
  it("flags a new reference to the legacy asset by basename", () => {
    const added: DiffLine[] = [{ file: "src/Header.tsx", line: 3, text: 'import logo from "/logo/logo.svg";' }];
    const v = runRuleCheck(r, added);
    expect(v).toHaveLength(1);
    expect(v[0]?.detail).toContain("logo.svg");
  });
});

describe("palette_conformance", () => {
  const r = rule({ type: "palette_conformance", allowedHexes: ["#6609be"], maxDeltaE: 5 });
  it("passes a near-identical brand purple, flags a foreign color", () => {
    expect(runRuleCheck(r, [{ file: "a.tsx", line: 1, text: "color: #6a0bc1" }])).toHaveLength(0);
    expect(runRuleCheck(r, [{ file: "a.tsx", line: 1, text: "color: #ff5722" }])).toHaveLength(1);
  });
});
