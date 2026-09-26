// The repo profiler, pinned.
//
// The profile's job is to be the thing a breakdown is proposed FROM, so its failure
// mode is not crashing — it is being confidently wrong in a way that produces a file
// surface matching nothing. The pilot has two dead runs from exactly that:
//
//   · an agent that returned an empty file list, and
//   · an agent that needed cart.mjs while the declared surface said otherwise,
//     which is a non-recoverable error and killed the run outright.
//
// So the tests here are mostly about honesty: infer the repo's real test convention
// rather than assuming one, say so when there are no tests at all, and report
// truncation instead of letting a partial survey read as complete.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileRepo, renderProfile } from "./repo-profiler.js";

/** Builds a throwaway repo from a path -> contents map. */
async function repoWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "signet-profile-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    const slash = full.lastIndexOf("/");
    if (slash !== -1) await mkdir(full.slice(0, slash), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const roots: string[] = [];
async function fixture(files: Record<string, string>): Promise<string> {
  const root = await repoWith(files);
  roots.push(root);
  return root;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("inferring how a repo names its tests", () => {
  it("reads the convention off the repo instead of assuming one", async () => {
    // This is the bug being prevented: proposing `__tests__/cart.js` for a repo
    // that writes `cart.test.mjs` yields a surface that matches no file.
    const root = await fixture({
      "cart.mjs": "export const cart = () => {};\n",
      "cart.test.mjs": "import { cart } from './cart.mjs';\n",
      "badge.mjs": "export const badge = () => {};\n",
      "badge.test.mjs": "import { badge } from './badge.mjs';\n",
    });
    const p = await profileRepo(root);
    expect(p.testConvention?.pattern).toBe("*.test.*");
    expect(p.testConvention?.examples).toContain("cart.test.mjs");
  });

  it("picks the convention with the most files when a repo mixes them", async () => {
    const root = await fixture({
      "a.spec.ts": "",
      "b.spec.ts": "",
      "c.spec.ts": "",
      "legacy.test.ts": "",
    });
    const p = await profileRepo(root);
    expect(p.testConvention?.pattern).toBe("*.spec.*");
  });

  it("says there are no tests rather than guessing a framework", async () => {
    // "No tests here" is more useful than a plausible guess: it tells the proposer
    // not to promise a test file the repo has no way to run.
    const root = await fixture({ "index.mjs": "export const x = 1;\n" });
    const p = await profileRepo(root);
    expect(p.testConvention).toBeNull();
    expect(renderProfile(p)).toContain("No test files found");
  });

  it("marks test files individually, not just as a pattern", async () => {
    const root = await fixture({ "cart.mjs": "", "cart.test.mjs": "" });
    const p = await profileRepo(root);
    expect(p.files.find((f) => f.path === "cart.test.mjs")?.isTest).toBe(true);
    expect(p.files.find((f) => f.path === "cart.mjs")?.isTest).toBe(false);
  });
});

describe("what the profile refuses to include", () => {
  it("ignores dependencies and build output", async () => {
    const root = await fixture({
      "src/real.ts": "export const real = 1;\n",
      "node_modules/pkg/index.js": "module.exports = {};\n",
      "dist/bundle.js": "console.log(1);\n",
      "coverage/report.json": "{}\n",
    });
    const p = await profileRepo(root);
    const paths = p.files.map((f) => f.path);
    expect(paths).toEqual(["src/real.ts"]);
  });

  it("ignores dot directories, so .git and friends stay out", async () => {
    const root = await fixture({ "app.ts": "", ".github/workflows/ci.yml": "" });
    const p = await profileRepo(root);
    expect(p.files.map((f) => f.path)).toEqual(["app.ts"]);
  });
});

describe("honesty about what it could not see", () => {
  it("survives an empty repo instead of throwing", async () => {
    // "I learned nothing about this repo" is a fact the proposer should act on,
    // not an exception that buries the reason.
    const root = await fixture({});
    const p = await profileRepo(root);
    expect(p.files).toEqual([]);
    expect(p.testConvention).toBeNull();
    expect(p.truncated.files).toBe(false);
  });

  it("survives a path that does not exist", async () => {
    const p = await profileRepo(join(tmpdir(), "signet-does-not-exist-ever"));
    expect(p.files).toEqual([]);
  });

  it("reports truncation rather than letting a partial survey look complete", async () => {
    // Rendering must carry the warning too — the model reads the text, not the object.
    const root = await fixture({ "a.ts": "" });
    const p = await profileRepo(root);
    const pretending = { ...p, truncated: { files: true, limit: 4000 } };
    expect(renderProfile(pretending)).toContain("partial");
  });
});

describe("the rendered survey", () => {
  let root: string;
  beforeAll(async () => {
    root = await fixture({
      "package.json": '{\n  "name": "demo",\n  "scripts": { "test": "node run-tests.mjs" }\n}\n',
      "src/index.ts": "export const main = () => {};\n",
      "src/cart.ts": "export const cart = () => {};\n",
      "src/cart.spec.ts": "import { cart } from './cart.js';\n",
    });
  });

  it("tells the model the test convention is binding", async () => {
    const text = renderProfile(await profileRepo(root));
    expect(text).toContain("*.spec.*");
    expect(text).toMatch(/MUST follow this convention/);
  });

  it("includes the manifest, because it says how the repo is run", async () => {
    const text = renderProfile(await profileRepo(root));
    expect(text).toContain("node run-tests.mjs");
  });

  it("finds entry points by conventional name", async () => {
    const p = await profileRepo(root);
    expect(p.entryPoints).toContain("src/index.ts");
  });

  it("caps the file list and says how many it left out", async () => {
    const text = renderProfile(await profileRepo(root), { maxFiles: 1 });
    expect(text).toMatch(/and \d+ more files not listed/);
  });

  it("counts lines, not just bytes", async () => {
    // A 40-line file and a 4000-line file imply different decompositions, and byte
    // size conflates the two with minification and long lines.
    const p = await profileRepo(root);
    expect(p.files.find((f) => f.path === "src/index.ts")?.lines).toBeGreaterThan(0);
  });
});

describe("quoting the actual code", () => {
  it("includes file contents, not just names and line counts", async () => {
    // The gap this closes, in the proposer's own words from the first real run:
    // "I couldn't read the file contents; only names and line counts were available."
    // It then assumed what cart.mjs did. Planning from a directory listing is guessing.
    const root = await fixture({ "cart.mjs": "export const total = (i) => i.length;\n" });
    const text = renderProfile(await profileRepo(root));
    expect(text).toContain("export const total");
  });

  it("says how many files it could not afford to quote", async () => {
    const root = await fixture({
      "a.mjs": "export const a = 'aaaaaaaaaaaaaaaaaaaa';\n",
      "b.mjs": "export const b = 'bbbbbbbbbbbbbbbbbbbb';\n",
    });
    // A tiny budget forces an omission, which must be reported rather than silent:
    // a plan built on half the code should not read like one built on all of it.
    const text = renderProfile(await profileRepo(root), { contentBudget: 45 });
    expect(text).toMatch(/were not quoted above|was not quoted above/);
    expect(text).toContain("Do not assume you have seen everything");
  });

  it("prefers source over tests when the budget is tight", async () => {
    // Tests are the best evidence of convention, but useless without the code they
    // exercise, so they go last.
    const root = await fixture({
      "cart.mjs": "export const cart = 1;\n",
      "cart.test.mjs": "import './cart.mjs';\n",
    });
    const text = renderProfile(await profileRepo(root), { contentBudget: 30 });
    expect(text).toContain("export const cart");
    expect(text).not.toContain("import './cart.mjs'");
  });

  it("lists a huge file without quoting it", async () => {
    // A minified bundle would crowd out everything useful.
    const root = await fixture({ "big.mjs": "x".repeat(40 * 1024), "small.mjs": "export const s = 1;\n" });
    const p = await profileRepo(root);
    expect(p.files.find((f) => f.path === "big.mjs")?.content).toBeNull();
    expect(p.files.find((f) => f.path === "small.mjs")?.content).not.toBeNull();
    // Still listed, so the proposer knows it exists and can put it in a surface.
    expect(renderProfile(p)).toContain("big.mjs");
  });
});
