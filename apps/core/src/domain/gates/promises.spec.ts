// The promises check. The claim comes from the agent; the proof comes from the diff.
// These tests are mostly about the second half: a confident claim that is not backed by
// the change must never read as proven.

import { describe, expect, it } from "vitest";
import { extractPromises, parseProofClaims, parseUnifiedDiff, proofInstruction, verifyProofs } from "./promises.js";

describe("extractPromises — what done when promises", () => {
  it("reads one promise per bullet, without markdown", () => {
    expect(
      extractPromises("- Above 40 markers, clusters are drawn\n- A **cluster of one** draws as the marker\n* `zoom` splits clusters"),
    ).toEqual(["Above 40 markers, clusters are drawn", "A cluster of one draws as the marker", "zoom splits clusters"]);
  });

  it("falls back to bold spans, the wireframe convention", () => {
    expect(extractPromises("Defaults to 60. **A value that is not positive is rejected.** **Nothing is clamped.**")).toEqual([
      "A value that is not positive is rejected.",
      "Nothing is clamped.",
    ]);
  });

  it("falls back to sentences for plain prose", () => {
    expect(extractPromises("It totals 90 for a 10% discount. It rejects -5. It rejects 101.")).toEqual([
      "It totals 90 for a 10% discount.",
      "It rejects -5.",
      "It rejects 101.",
    ]);
  });

  it("returns nothing for an empty done-when, rather than inventing a promise", () => {
    expect(extractPromises("   ")).toEqual([]);
  });

  it("drops duplicates and caps a runaway list", () => {
    const many = Array.from({ length: 30 }, (_, i) => `- promise ${i}`).join("\n");
    expect(extractPromises(`${many}\n- promise 0`)).toHaveLength(12);
  });

  it("numbers them in the prompt so a claim can point at one", () => {
    const text = proofInstruction(["a", "b"]);
    expect(text).toContain("1. a");
    expect(text).toContain("2. b");
    expect(proofInstruction([])).toBe("");
  });
});

describe("parseProofClaims", () => {
  it("uses the LAST fenced block that holds proofs", () => {
    const reply = [
      "Here is the config I changed:",
      "```json",
      '{"radius": 60}',
      "```",
      "Done.",
      "```json",
      '{ "proofs": [ { "promise": 1, "test": "groups markers" } ] }',
      "```",
    ].join("\n");
    expect(parseProofClaims(reply)).toEqual([{ promise: 1, test: "groups markers" }]);
  });

  it("accepts an unfenced object at the end", () => {
    expect(parseProofClaims('All done. {"proofs":[{"promise":2,"test":null}]}')).toEqual([{ promise: 2, test: null }]);
  });

  it("returns null when there is no claim at all — which is different from claiming nothing", () => {
    expect(parseProofClaims("I wrote the tests.")).toBeNull();
    expect(parseProofClaims('```json\n{"proofs": "yes"}\n```')).toBeNull();
  });
});

const PATCH = [
  "diff --git a/src/layer.ts b/src/layer.ts",
  "--- a/src/layer.ts",
  "+++ b/src/layer.ts",
  "@@ -40 +40,4 @@ export function drawLayer",
  "-  markers.forEach(draw);",
  "+  if (markers.length <= 40) {",
  "+    markers.forEach(draw);",
  "+    return;",
  "+  }",
  "@@ -47,0 +51,1 @@",
  "+  if (c.count === 1) drawMarker(map, c.members[0]);",
  "diff --git a/src/layer.test.ts b/src/layer.test.ts",
  "--- /dev/null",
  "+++ b/src/layer.test.ts",
  "@@ -0,0 +1,3 @@",
  "+it(\"groups markers above the threshold\", () => {});",
  "+it('renders a cluster of one as a plain marker', () => {});",
  "+// helper",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("records added lines at their new-side numbers, and the hunks they sit in", () => {
    const changes = parseUnifiedDiff(PATCH);
    const layer = changes.get("src/layer.ts");
    expect(layer?.added.get(40)).toBe("  if (markers.length <= 40) {");
    expect(layer?.added.get(51)).toContain("c.count === 1");
    expect(layer?.hunks).toEqual([
      [40, 43],
      [51, 51],
    ]);
    expect(changes.get("src/layer.test.ts")?.added.size).toBe(3);
  });
});

describe("verifyProofs — the claim is checked, not believed", () => {
  const promises = ["Above 40 markers, clusters are drawn", "A cluster of one draws as the marker", "Zooming in splits a cluster"];
  const changes = parseUnifiedDiff(PATCH);

  it("proves a promise whose named test was added in this change", () => {
    const [first] = verifyProofs({
      promises,
      claims: [{ promise: 1, test: "groups markers above the threshold", testFile: "src/layer.test.ts", codeFile: "src/layer.ts", codeLines: "40-43" }],
      changes,
    });
    expect(first).toMatchObject({ proven: true, testFile: "src/layer.test.ts", codeFile: "src/layer.ts", codeLines: "40–43", reason: null });
  });

  it("matches a title through different quotes and finds the file when none is named", () => {
    const [, second] = verifyProofs({
      promises,
      claims: [{ promise: 2, test: "“renders a cluster of one as a plain marker”" }],
      changes,
    });
    expect(second).toMatchObject({ proven: true, testFile: "src/layer.test.ts" });
  });

  it("does NOT prove a promise whose named test is not in the change", () => {
    const [, , third] = verifyProofs({
      promises,
      claims: [{ promise: 3, test: "splits a cluster back apart as zoom increases" }],
      changes,
    });
    expect(third?.proven).toBe(false);
    expect(third?.reason).toContain("no test with that title was added");
  });

  it("says plainly when no test was named, and when the agent made no claims at all", () => {
    const named = verifyProofs({ promises, claims: [{ promise: 1, test: null }], changes });
    expect(named.map((p) => p.reason)).toEqual(["No test proves this.", "No test proves this.", "No test proves this."]);
    const silent = verifyProofs({ promises, claims: null, changes });
    expect(silent[0]?.reason).toBe("The agent did not say which test proves this.");
  });

  it("drops code lines that point outside what changed, rather than showing them wrong", () => {
    const [first] = verifyProofs({
      promises,
      claims: [{ promise: 1, test: "groups markers above the threshold", codeFile: "src/layer.ts", codeLines: "120-130" }],
      changes,
    });
    expect(first).toMatchObject({ proven: true, codeFile: null, codeLines: null });
  });

  it("does not accept a title that appears only in a source file", () => {
    const [first] = verifyProofs({
      promises,
      claims: [{ promise: 1, test: "markers.forEach(draw)" }],
      changes,
    });
    expect(first?.proven).toBe(false);
  });
});
