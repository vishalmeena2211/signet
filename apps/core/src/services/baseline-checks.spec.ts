// The checks, run on main before any step is judged by them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { testsGate, typecheckGate } from "../domain/gates/standard-gates.js";
import { makeRunOnBase } from "../domain/gates/base-overlay.js";
import { BaselineChecks, toCheck } from "./baseline-checks.js";

const exec = promisify(execFile);

describe("toCheck — a gate verdict read as 'can this run here'", () => {
  it("names an environment fault as cannot run, not as a failing check", () => {
    const c = toCheck(
      "tests",
      "npm test",
      { v: { gate: "tests", outcome: "fail", findings: [{ dimension: "environment", message: "exited 127" }] }, ms: 5 },
      "",
    );
    expect(c).toMatchObject({ outcome: "cannot_run", detail: "exited 127" });
  });

  it("says a failure on main is inherited by every step", () => {
    const c = toCheck("typecheck", "npx tsc --noEmit", { v: { gate: "typecheck", outcome: "fail", findings: [{ dimension: "type_error", message: "error TS2322" }] }, ms: 5 }, "");
    expect(c.outcome).toBe("fail");
    expect(c.detail).toContain("Already failing on main: error TS2322");
  });
});

describe("BaselineChecks against a real repo", () => {
  let root: string;
  let repo: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "signet-baseline-"));
    repo = join(root, "repo");
    await exec("mkdir", ["-p", repo]);
    const git = (...a: string[]) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
    await git("init", "-q", "-b", "main");
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e \"process.exit(0)\"" } }));
    await git("add", "-A");
    await git("commit", "-q", "-m", "base");
    // A change that is NOT committed must not affect a check of main.
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e \"process.exit(1)\"" } }));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs on the committed base ref, reports each check, and remembers the result", async () => {
    const checks = new BaselineChecks({
      typecheck: typecheckGate(),
      tests: testsGate({ runOnBase: makeRunOnBase() }),
      storePath: join(root, "baselines.json"),
    });
    const report = await checks.run({ path: repo, label: "repo" }, "main");
    expect(report.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(report.checks.map((c) => [c.check, c.outcome])).toEqual([
      ["typecheck", "skipped"],
      ["lint", "skipped"],
      ["tests", "pass"],
    ]);
    expect((await checks.last(repo))?.sha).toBe(report.sha);
    expect(await checks.last("/nowhere")).toBeNull();
  }, 60_000);
});
