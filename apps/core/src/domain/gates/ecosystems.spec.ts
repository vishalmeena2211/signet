// Checking repos that are not JavaScript. The tests check used to run only `npm test`, so
// on a Python, Go or Rust repo it skipped without a word and no promise could be proven.
// These run real runners on real little repos where the machine has them.

import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RunIdSchema } from "@signet/contracts";
import { detectEcosystem, isTestFile, runnerMissing, suitePassed, TEST_DECLARATION } from "./ecosystems.js";
import { lintGate, testsGate, typecheckGate } from "./standard-gates.js";
import { opensWithComment, portrait, testedBy } from "../../services/portrait.js";
import { makeRunOnBase } from "./base-overlay.js";

const exec = promisify(execFile);
const has = (cmd: string, args: string[]) => exec(cmd, args).then(
  () => true,
  () => false,
);

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "signet-eco-"));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

/** A repo with `base` committed on main and `change` on a step branch, as a step leaves it. */
async function stepRepo(base: Record<string, string>, change: Record<string, string>): Promise<{ dir: string; changed: string[] }> {
  const dir = await repo(base);
  const git = (...a: string[]) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-qm", "base");
  await git("checkout", "-qb", "signet/step");
  for (const [name, text] of Object.entries(change)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  await git("add", "-A");
  await git("commit", "-qm", "step");
  return { dir, changed: Object.keys(change) };
}

const gate = testsGate({ runOnBase: makeRunOnBase() });
const ctx = (dir: string, changed: string[]) => ({ workspacePath: dir, baseRef: "main", changedFiles: changed, runId: RunIdSchema.parse("00000000-0000-4000-8000-000000000001") });

describe("which ecosystem a repo is, and how its tests run", () => {
  it("reads each ecosystem from its own manifest", async () => {
    expect((await detectEcosystem(await repo({ "go.mod": "module x\n" })))?.tests).toMatchObject({ shown: "go test ./..." });
    expect((await detectEcosystem(await repo({ "Cargo.toml": "[package]\n" })))?.tests).toMatchObject({ shown: "cargo test --quiet" });
    expect((await detectEcosystem(await repo({ "pyproject.toml": "" })))?.tests).toMatchObject({ cmd: "python3", args: expect.arrayContaining(["pytest"]) });
    expect(await detectEcosystem(await repo({ "README.md": "" }))).toBeNull();
  });

  it("runs a Node repo's tests with the package manager it uses, and never npm's placeholder", async () => {
    const pnpm = await repo({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "pnpm-lock.yaml": "" });
    expect((await detectEcosystem(pnpm))?.tests).toMatchObject({ shown: "pnpm test" });
    // Both lockfiles, as a real repo had: npm, whose lockfile is there, not pnpm.
    const both = await repo({ "package.json": JSON.stringify({ scripts: { test: "jest" } }), "pnpm-lock.yaml": "", "package-lock.json": "{}" });
    expect((await detectEcosystem(both))?.tests).toMatchObject({ cmd: "npm" });
    const declared = await repo({ "package.json": JSON.stringify({ packageManager: "yarn@4.1.0", scripts: { test: "jest" } }), "package-lock.json": "{}" });
    expect((await detectEcosystem(declared))?.tests).toMatchObject({ shown: "yarn test" });
    const placeholder = await repo({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    expect((await detectEcosystem(placeholder))?.tests).toEqual({ none: "package.json has no test script." });
  });

  it("knows each ecosystem's test files and test declarations", () => {
    for (const f of ["cart.test.mjs", "src/a.spec.ts", "tests/test_cart.py", "cart_test.py", "cart_test.go", "tests/cart.rs"]) expect(isTestFile(f), f).toBe(true);
    for (const f of ["cart.mjs", "src/cart.py", "cart.go", "src/lib.rs"]) expect(isTestFile(f), f).toBe(false);
    for (const l of ['test("adds", () => {', "def test_adds():", "func TestAdds(t *testing.T) {", '\tt.Run("adds", func(t *testing.T) {', "fn adds_two() {"]) {
      expect(TEST_DECLARATION.test(l), l).toBe(true);
    }
    expect(TEST_DECLARATION.test("# test_adds is covered elsewhere")).toBe(false);
  });

  it("tells a missing runner from failing code, and an empty pytest run from a failed one", () => {
    expect(runnerMissing("node", 127, "")).toBe(true);
    expect(runnerMissing("python", 1, "/usr/bin/python3: No module named pytest")).toBe(true);
    expect(runnerMissing("python", 1, "1 failed")).toBe(false);
    expect(suitePassed("python", 5)).toBe(true);
    expect(suitePassed("go", 5)).toBe(false);
  });

  it("says why when a repo's tests cannot be run, instead of skipping silently", async () => {
    const v = await gate.run(ctx(await repo({ "README.md": "" }), []));
    expect(v).toMatchObject({ outcome: "skipped", findings: [{ dimension: "no_runner" }] });
    expect(v.findings[0]?.message).toContain("Python (pytest), Go and Rust");
  });
});

describe("the tests check on real repos in other languages", { timeout: 120_000 }, () => {
  const goBase = { "go.mod": "module calc\n\ngo 1.21\n", "calc.go": "package calc\n\nfunc Add(a, b int) int { return a + b }\n" };

  it("Go: a new test that fails on the old code proves the change", async (t) => {
    if (!(await has("go", ["version"]))) return t.skip();
    const { dir, changed } = await stepRepo(goBase, {
      "calc.go": "package calc\n\nfunc Add(a, b int) int { return a + b }\n\nfunc Sub(a, b int) int { return a - b }\n",
      "calc_test.go": 'package calc\n\nimport "testing"\n\nfunc TestSub(t *testing.T) {\n\tif Sub(5, 3) != 2 {\n\t\tt.Fatal("Sub broken")\n\t}\n}\n',
    });
    expect(await gate.run(ctx(dir, changed))).toMatchObject({ outcome: "pass" });
  });

  it("Go: a test that already passed on the old code proves nothing", async (t) => {
    if (!(await has("go", ["version"]))) return t.skip();
    const { dir, changed } = await stepRepo(goBase, {
      "calc.go": "package calc\n\n// Add adds.\nfunc Add(a, b int) int { return a + b }\n",
      "calc_test.go": 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal("Add broken")\n\t}\n}\n',
    });
    expect(await gate.run(ctx(dir, changed))).toMatchObject({ outcome: "fail", findings: [{ dimension: "fail_then_pass" }] });
  });

  it("Rust: an integration test that fails on the old code proves the change", async (t) => {
    if (!(await has("cargo", ["--version"]))) return t.skip();
    const base = { "Cargo.toml": '[package]\nname = "calc"\nversion = "0.1.0"\nedition = "2021"\n', "src/lib.rs": "pub fn add(a: i32, b: i32) -> i32 { a + b }\n" };
    const { dir, changed } = await stepRepo(base, {
      "src/lib.rs": "pub fn add(a: i32, b: i32) -> i32 { a + b }\n\npub fn sub(a: i32, b: i32) -> i32 { a - b }\n",
      "tests/sub.rs": "#[test]\nfn subtracts() {\n    assert_eq!(calc::sub(5, 3), 2);\n}\n",
    });
    expect(await gate.run(ctx(dir, changed))).toMatchObject({ outcome: "pass" });
  });

  it("Python: without pytest installed, it says the runner is missing rather than blaming the code", async (t) => {
    if (!(await has("python3", ["--version"]))) return t.skip();
    const withPytest = await has("python3", ["-m", "pytest", "--version"]);
    const { dir, changed } = await stepRepo(
      { "pyproject.toml": '[project]\nname = "calc"\nversion = "0.1.0"\n', "calc.py": "def add(a, b):\n    return a + b\n" },
      {
        "calc.py": "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n",
        "test_calc.py": "from calc import sub\n\n\ndef test_sub():\n    assert sub(5, 3) == 2\n",
      },
    );
    const v = await gate.run(ctx(dir, changed));
    if (withPytest) expect(v).toMatchObject({ outcome: "pass" });
    else expect(v).toMatchObject({ outcome: "fail", findings: [{ dimension: "environment", message: expect.stringContaining("pytest is not installed") }] });
  });
});

describe("Go's own checks for types and format, and a portrait in Go's terms", { timeout: 120_000 }, () => {
  const mod = { "go.mod": "module calc\n\ngo 1.21\n" };

  it("go vet passes clean code and catches a real mistake", async (t) => {
    if (!(await has("go", ["version"]))) return t.skip();
    const clean = await repo({ ...mod, "calc.go": 'package calc\n\nimport "fmt"\n\nfunc Show(n int) string { return fmt.Sprintf("%d", n) }\n' });
    expect(await typecheckGate().run(ctx(clean, ["calc.go"]))).toMatchObject({ outcome: "pass" });
    const wrong = await repo({ ...mod, "calc.go": 'package calc\n\nimport "fmt"\n\nfunc Show(s string) string { return fmt.Sprintf("%d", s) }\n' });
    const v = await typecheckGate().run(ctx(wrong, ["calc.go"]));
    expect(v.outcome).toBe("fail");
    expect(v.findings[0]?.message).toContain("calc.go");
  });

  it("gofmt flags a changed file that is not formatted, and names the fix", async (t) => {
    if (!(await has("go", ["version"]))) return t.skip(); // gofmt ships with Go
    const messy = await repo({ ...mod, "calc.go": "package calc\nfunc Add(a,b int) int {return a+b}\n" });
    const v = await lintGate().run(ctx(messy, ["calc.go"]));
    expect(v).toMatchObject({ outcome: "fail", findings: [{ message: "calc.go is not gofmt-formatted: run gofmt -w calc.go" }] });
    const tidy = await repo({ ...mod, "calc.go": "package calc\n\nfunc Add(a, b int) int { return a + b }\n" });
    expect(await lintGate().run(ctx(tidy, ["calc.go"]))).toMatchObject({ outcome: "pass" });
  });

  it("describes a Go repo's tests in Go's terms, and knows a _test.go covers its file", async () => {
    const dir = await repo({ ...mod, "calc.go": "package calc\n\nfunc Add(a, b int) int { return a + b }\n", "calc_test.go": 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {}\n' });
    const p = await portrait({ id: dir, label: "calc", path: dir }, { get: async () => null, set: async () => {} } as never);
    const text = JSON.stringify(p);
    expect(text).toContain("Go’s own testing package");
    expect(text).not.toContain("a test script");
    expect(p.asks.some((a) => a.includes("without a test"))).toBe(false);
  });

  it("pairs each ecosystem's tests with the files they test", () => {
    expect(testedBy("src/cart.test.ts")).toEqual(["src/cart.ts"]);
    expect(testedBy("pkg/calc_test.go")).toEqual(["pkg/calc.go"]);
    expect(testedBy("tests/test_cart.py")).toContain("cart.py");
    expect(testedBy("cart_test.py")).toEqual(["cart.py"]);
    expect(testedBy("tests/sub.rs")).toEqual(["src/sub.rs", "src/lib.rs"]);
  });
});

describe("Rust's own checks, and a portrait that knows how a crate is tested", { timeout: 180_000 }, () => {
  const crate = { "Cargo.toml": '[package]\nname = "calc"\nversion = "0.1.0"\nedition = "2021"\n' };

  it("cargo check passes a sound crate and catches a type error", async (t) => {
    if (!(await has("cargo", ["--version"]))) return t.skip();
    const sound = await repo({ ...crate, "src/lib.rs": "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n" });
    expect(await typecheckGate().run(ctx(sound, ["src/lib.rs"]))).toMatchObject({ outcome: "pass" });
    const broken = await repo({ ...crate, "src/lib.rs": 'pub fn add(a: i32, b: i32) -> i32 {\n    let x: i32 = "one";\n    a + b + x\n}\n' });
    const v = await typecheckGate().run(ctx(broken, ["src/lib.rs"]));
    expect(v.outcome).toBe("fail");
    expect(v.findings.map((f) => f.message).join("\n")).toContain("src/lib.rs");
  });

  it("rustfmt flags a changed file that is not formatted, and names the fix", async (t) => {
    if (!(await has("rustfmt", ["--version"]))) return t.skip();
    const messy = await repo({ ...crate, "src/lib.rs": "pub fn add(a:i32,b:i32)->i32{a+b}\n" });
    expect(await lintGate().run(ctx(messy, ["src/lib.rs"]))).toMatchObject({ outcome: "fail", findings: [{ message: "src/lib.rs is not rustfmt-formatted: run rustfmt src/lib.rs" }] });
    const tidy = await repo({ ...crate, "src/lib.rs": "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n" });
    expect(await lintGate().run(ctx(tidy, ["src/lib.rs"]))).toMatchObject({ outcome: "pass" });
  });

  it("counts a crate's tests/ folder as testing src/lib.rs, and does not suggest a comment it already has", async () => {
    const dir = await repo({
      ...crate,
      "src/lib.rs": "//! Counting words.\n\npub fn count(s: &str) -> usize {\n    s.split_whitespace().count()\n}\n",
      "tests/count.rs": "#[test]\nfn counts() {\n    assert_eq!(calc::count(\"a b\"), 2);\n}\n",
    });
    const p = await portrait({ id: dir, label: "calc", path: dir }, { get: async () => null, set: async () => {} } as never);
    expect(JSON.stringify(p)).toContain("cargo’s test harness");
    expect(p.asks.some((a) => a.includes("without a test"))).toBe(false);
    expect(p.asks.some((a) => a.includes("comment at its top"))).toBe(false);
  });

  it("counts a Rust file with its own #[cfg(test)] module as tested", async () => {
    const dir = await repo({ ...crate, "src/lib.rs": "pub fn one() -> i32 {\n    1\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn is_one() {\n        assert_eq!(super::one(), 1);\n    }\n}\n" });
    const p = await portrait({ id: dir, label: "calc", path: dir }, { get: async () => null, set: async () => {} } as never);
    expect(p.asks.some((a) => a.includes("without a test"))).toBe(false);
  });

  it("knows a file that already opens with a comment, in each language", () => {
    for (const t of ["// Package calc adds.\npackage calc", "//! Counting words.", '"""Parse temperatures."""', "#!/usr/bin/env python3\n# Tools.", "/* A module */"]) expect(opensWithComment(t), t).toBe(true);
    for (const t of ["package calc", "#[derive(Debug)]\npub struct X;", "export const a = 1;", ""]) expect(opensWithComment(t), t).toBe(false);
  });
});
