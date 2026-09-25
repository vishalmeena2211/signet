import { describe, expect, it } from "vitest";
import { IncrementIdSchema, type DesignOfRecord } from "@signet/contracts";
import { analyzeConformance, type VlmJudge } from "./conformance.js";
import type { DiffLine } from "./rule-check.js";

const INC = IncrementIdSchema.parse("11111111-aaaa-4bbb-8ccc-00000000c0af");

function design(intent: Partial<DesignOfRecord["intent"]>, extra: Partial<DesignOfRecord> = {}): DesignOfRecord {
  return {
    incrementId: INC,
    source: "resolved",
    approvedBy: "vishal",
    approvedAt: new Date().toISOString(),
    intent: {
      palette: [],
      maxDeltaE: 8,
      forbiddenColors: [],
      requiredAssets: [],
      forbiddenAssets: [],
      ...intent,
    },
    ...extra,
  };
}

describe("conformance — deterministic path", () => {
  it("passes when new colors sit within the approved palette", async () => {
    const added: DiffLine[] = [{ file: "a.tsx", line: 1, text: "color: #6a0bc1" }]; // ≈ #6609be
    const r = await analyzeConformance({
      design: design({ palette: ["#6609be"], maxDeltaE: 8 }),
      addedLines: added,
      changedFiles: ["a.tsx"],
    });
    expect(r.overallPassed).toBe(true);
    expect(r.dimensions.find((d) => d.dimension === "palette")?.passed).toBe(true);
  });

  it("THE WEDGE: flags a build that diverges from the approved palette, per dimension", async () => {
    const added: DiffLine[] = [{ file: "promo.tsx", line: 9, text: "background: #ff5722" }];
    const r = await analyzeConformance({
      design: design({ palette: ["#6609be"], maxDeltaE: 8 }),
      addedLines: added,
      changedFiles: ["promo.tsx"],
    });
    const pal = r.dimensions.find((d) => d.dimension === "palette");
    expect(pal?.passed).toBe(false);
    expect(pal?.evidence[0]).toContain("promo.tsx:9");
    expect(r.overallPassed).toBe(false);
  });

  it("catches a forbidden legacy asset reference", async () => {
    const added: DiffLine[] = [{ file: "Header.tsx", line: 3, text: 'src="/logo/logo.svg"' }];
    const r = await analyzeConformance({
      design: design({ forbiddenAssets: ["public/logo/logo.svg"] }),
      addedLines: added,
      changedFiles: ["Header.tsx"],
    });
    expect(r.dimensions.find((d) => d.dimension === "forbidden_asset")?.passed).toBe(false);
  });

  it("flags a missing required asset", async () => {
    const r = await analyzeConformance({
      design: design({ requiredAssets: ["public/images/logo-new.png"] }),
      addedLines: [{ file: "Header.tsx", line: 1, text: "const x = 1" }],
      changedFiles: ["Header.tsx"],
    });
    expect(r.dimensions.find((d) => d.dimension === "required_asset")?.passed).toBe(false);
  });

  it("keeps dimensions separate — never collapsed to one score", async () => {
    const r = await analyzeConformance({
      design: design({ palette: ["#6609be"], forbiddenColors: ["#010043"] }),
      addedLines: [
        { file: "a.tsx", line: 1, text: "color: #6609be" },
        { file: "b.tsx", line: 2, text: "color: #010043" },
      ],
      changedFiles: ["a.tsx", "b.tsx"],
    });
    expect(r.dimensions.map((d) => d.dimension).sort()).toEqual(["forbidden_color", "palette"]);
    expect(r.dimensions.find((d) => d.dimension === "palette")?.passed).toBe(true);
    expect(r.dimensions.find((d) => d.dimension === "forbidden_color")?.passed).toBe(false);
  });
});

describe("conformance — VLM path (scaffolded)", () => {
  it("invokes the judge when a render + reference + judge are all present", async () => {
    let called = false;
    const vlm: VlmJudge = {
      async judge() {
        called = true;
        return { score: 0.92, notes: "matches the approved mock" };
      },
    };
    const r = await analyzeConformance({
      design: design({}, { referenceImagePath: "/ref.png" }),
      addedLines: [],
      changedFiles: [],
      builtImagePath: "/built.png",
      vlm,
    });
    expect(called).toBe(true);
    expect(r.dimensions.find((d) => d.dimension === "vlm_judgment")?.passed).toBe(true);
  });

  it("does not invoke the VLM when no render is available (source-only pilot)", async () => {
    let called = false;
    const vlm: VlmJudge = {
      async judge() {
        called = true;
        return { score: 1, notes: "" };
      },
    };
    await analyzeConformance({
      design: design({ palette: ["#6609be"] }, { referenceImagePath: "/ref.png" }),
      addedLines: [{ file: "a.tsx", line: 1, text: "#6609be" }],
      changedFiles: ["a.tsx"],
      vlm,
    });
    expect(called).toBe(false);
  });
});
