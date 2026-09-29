// The promises check. The claim comes from the agent; the proof comes from the diff.
// These tests are mostly about the second half: a confident claim that is not backed by
// the change must never read as proven.

import { describe, expect, it } from "vitest";
import { creditTestsCheck, extractPromises, isSuitePromise, parseProofClaims, parseUnifiedDiff, proofInstruction, verifyProofs } from "./promises.js";

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

  it("drops duplicates, and never the thirteenth promise or any other", () => {
    // A real plan had thirteen promises; the thirteenth vanished from the agent's
    // instructions, the check and the seal.
    const many = Array.from({ length: 30 }, (_, i) => `- promise ${i}`).join("\n");
    expect(extractPromises(`${many}\n- promise 0`)).toHaveLength(30);
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

describe("a promise that the suite passes is proven by the tests check", () => {
  it("recognises the suite promises proposals actually write", () => {
    // The first is word for word from a real proposal, which forced a seal on trust.
    for (const p of [
      "npm test exits with code 0, and cart.test.mjs reports ok",
      "All existing tests still pass",
      "The full test suite passes",
      "pnpm test passes with the new tests included",
      "npm run test exits 0",
    ]) {
      expect(isSuitePromise(p), p).toBe(true);
    }
  });

  it("leaves promises about behaviour alone, even when they mention tests", () => {
    for (const p of [
      "itemCount([]) returns 0",
      "itemCount does not change its input array or its items",
      "The existing exports still behave as before",
      "All tests pass and total() returns the sum",
      "The tests cover an empty cart",
      "Every item with a quantity field adds up that quantity",
    ]) {
      expect(isSuitePromise(p), p).toBe(false);
    }
  });

  const proofs = [
    { promise: "itemCount([]) returns 0", proven: true, test: "empty", testFile: "cart.test.mjs", codeFile: null, codeLines: null, reason: null },
    { promise: "npm test exits with code 0", proven: false, test: null, testFile: null, codeFile: null, codeLines: null, reason: "No test proves this." },
    { promise: "itemCount ignores a negative quantity", proven: false, test: null, testFile: null, codeFile: null, codeLines: null, reason: "No test proves this." },
  ];

  it("credits only the suite promise, and only when the tests check passed", () => {
    const credited = creditTestsCheck(proofs, true);
    expect(credited.map((p) => p.proven)).toEqual([true, true, false]);
    expect(credited[1]).toMatchObject({ bySuite: true, reason: null });
    // A skipped or failed tests check proves nothing about the suite.
    expect(creditTestsCheck(proofs, false).map((p) => p.proven)).toEqual([true, false, false]);
  });
});

describe("a test that already existed counts when this change edited its body", () => {
  // The shape of a real run: the palette test was extended to check every tone, and its
  // title line did not change, so no new title appeared in the diff.
  const file = [
    "import test from 'node:test';", //                                     1
    "test('badge returns label and brand purple background', () => {", //  2
    "  assert.equal(badge('New').background, '#6609be');", //               3
    "});", //                                                               4
    "// badge background stays within the approved brand palette", //      5
    "test('badge background stays within the approved brand palette', () => {", // 6
    "  const palette = ['#6609be', '#0b62d6', '#b25e00', '#c4122f'];", //  7
    "  for (const t of [undefined, 'info', 'warning', 'danger']) assert.ok(palette.includes(badge('x', t).background));", // 8
    "});", //                                                               9
  ].join("\n");
  const promises = ["The palette test checks the default badge and each tone against the palette"];
  const claims = [{ promise: 1, test: "badge background stays within the approved brand palette", testFile: "badge.test.mjs" }];
  const diffAt = (from: number, to: number) =>
    parseUnifiedDiff(
      [
        "--- a/badge.test.mjs",
        "+++ b/badge.test.mjs",
        `@@ -${from},1 +${from},${to - from + 1} @@`,
        ...Array.from({ length: to - from + 1 }, (_, i) => `+${file.split("\n")[from - 1 + i]}`),
      ].join("\n"),
    );
  const contents = new Map([["badge.test.mjs", file]]);

  it("is proven, and marked as a changed test, when a hunk falls inside its body", () => {
    const [proof] = verifyProofs({ promises, claims, changes: diffAt(7, 8), testContents: contents });
    expect(proof).toMatchObject({ proven: true, changedTest: true, testFile: "badge.test.mjs" });
  });

  it("is not proven when the change edited a different test", () => {
    const [proof] = verifyProofs({ promises, claims, changes: diffAt(3, 3), testContents: contents });
    expect(proof?.proven).toBe(false);
  });

  it("is not proven by a comment that only repeats the title", () => {
    const commentOnly = file.replace("test('badge background stays within the approved brand palette'", "test('something else'");
    const [proof] = verifyProofs({ promises, claims, changes: diffAt(7, 8), testContents: new Map([["badge.test.mjs", commentOnly]]) });
    expect(proof?.proven).toBe(false);
  });

  it("is not proven without the file's contents to look in", () => {
    const [proof] = verifyProofs({ promises, claims, changes: diffAt(7, 8) });
    expect(proof?.proven).toBe(false);
  });
});

describe("a promise kept by an existing test the change did not touch", () => {
  // From a real run: "banner('Sale now on') still returns exactly …" was proven by a test
  // that existed before and was not edited, and was marked unproven.
  const file = [
    "import test from 'node:test';",
    "test('banner returns text and brand purple background', () => {",
    "  assert.deepStrictEqual(banner('Sale now on'), { text: 'Sale now on', background: '#6609be' });",
    "});",
  ].join("\n");
  const promises = ["banner('Sale now on') still returns exactly { text: 'Sale now on', background: '#6609be' }"];
  const claims = [{ promise: 1, test: "banner returns text and brand purple background", testFile: "banner.test.mjs" }];
  const noChanges = parseUnifiedDiff("");

  it("is found but not yet proven: that is the tests check's to say", () => {
    const [proof] = verifyProofs({ promises, claims, changes: noChanges, testContents: new Map([["banner.test.mjs", file]]) });
    expect(proof).toMatchObject({ proven: false, existingTest: true, testFile: "banner.test.mjs" });
    expect(creditTestsCheck([proof!], true)[0]).toMatchObject({ proven: true, existingTest: true, reason: null });
    // A tests check that ran nothing did not run this test either.
    expect(creditTestsCheck([proof!], false)[0]?.proven).toBe(false);
  });

  it("is found even when other lines of its file changed, as long as its own body did not", () => {
    // The real run: a wrapper was added at the top of the file; this test was left alone.
    const changed = parseUnifiedDiff(["--- a/banner.test.mjs", "+++ b/banner.test.mjs", "@@ -1,0 +1,1 @@", "+import test from 'node:test';"].join("\n"));
    const [proof] = verifyProofs({ promises, claims, changes: changed, testContents: new Map([["banner.test.mjs", file]]) });
    expect(proof).toMatchObject({ proven: false, existingTest: true });
  });

  it("is not found in a different file than the one named", () => {
    const [proof] = verifyProofs({ promises, claims, changes: noChanges, testContents: new Map([["other.test.mjs", file]]) });
    expect(proof?.existingTest).toBeUndefined();
  });

  it("is not found in a comment that only repeats the title", () => {
    const comment = "// banner returns text and brand purple background\ntest('something else', () => {});";
    const [proof] = verifyProofs({ promises, claims, changes: noChanges, testContents: new Map([["banner.test.mjs", comment]]) });
    expect(proof?.existingTest).toBeUndefined();
  });
});
