// Gates tested against a real fixture repo: a node project whose test suite
// is executed for real — including the fail-then-pass falsifiability check
// with a genuine base-ref sandbox.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RunIdSchema, type GateVerdictView, type RunId } from "@signet/contracts";
import type { Logger } from "../runtime/logger.js";
import { GateSuite } from "./gate-runner.js";
import { makeRunOnBase } from "./base-overlay.js";
import { testsGate } from "./standard-gates.js";

const pexec = promisify(execFile);
const RUN = RunIdSchema.parse("44444444-aaaa-4bbb-8ccc-000000000001");

const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};

let repo: string;

async function git(args: string[], cwd: string) {
  await pexec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
}

/** Fixture: an add() with a plain-node test runner (no deps to install). */
beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "signet-gates-"));
  await git(["init", "-b", "main"], repo);
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ name: "fixture", private: true, scripts: { test: "node run-tests.mjs" } }),
  );
  await writeFile(
    join(repo, "run-tests.mjs"),
    `import { readdir } from "node:fs/promises";
const files = (await readdir(".")).filter((f) => f.endsWith(".test.mjs"));
let failed = 0;
for (const f of files) {
  try { await import("./" + f); console.log("ok " + f); }
  catch (e) { failed++; console.error("FAIL " + f + ": " + e.message); }
}
process.exit(failed === 0 ? 0 : 1);
`,
  );
  await writeFile(join(repo, "math.mjs"), "export const add = (a, b) => a + b;\n");
  await writeFile(
    join(repo, "math.test.mjs"),
    `import { add } from "./math.mjs";
if (add(1, 2) !== 3) throw new Error("add broken");
`,
  );
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);
  // The "agent change": a multiply function + its test, uncommitted on top.
  await writeFile(join(repo, "math.mjs"), "export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n");
  await writeFile(
    join(repo, "mul.test.mjs"),
    `import { mul } from "./math.mjs";
if (mul(2, 3) !== 6) throw new Error("mul broken");
`,
  );
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("tests gate — fail-then-pass discipline (real execution)", () => {
  const gate = testsGate({ runOnBase: makeRunOnBase() });

  it("a genuine falsifiable test passes the gate", async () => {
    const v = await gate.run({
      workspacePath: repo,
      baseRef: "main",
      changedFiles: ["math.mjs", "mul.test.mjs"],
      runId: RUN,
    });
    // mul.test.mjs fails on base (mul doesn't exist there) and passes on the
    // changed tree — exactly what the constitution demands.
    expect(v.outcome).toBe("pass");
  });

  it("a vacuous test (passes on base too) is REJECTED", async () => {
    await writeFile(
      join(repo, "vacuous.test.mjs"),
      `if (1 + 1 !== 2) throw new Error("universe broken");\n`,
    );
    const v = await gate.run({
      workspacePath: repo,
      baseRef: "main",
      changedFiles: ["vacuous.test.mjs"],
      runId: RUN,
    });
    expect(v.outcome).toBe("fail");
    expect(v.findings[0]?.dimension).toBe("fail_then_pass");
    await rm(join(repo, "vacuous.test.mjs"));
  });

  it("a broken suite on the changed tree fails with specific findings", async () => {
    await writeFile(
      join(repo, "broken.test.mjs"),
      `throw new Error("this change broke everything");\n`,
    );
    const v = await gate.run({
      workspacePath: repo,
      baseRef: "main",
      changedFiles: ["broken.test.mjs", "math.mjs"],
      runId: RUN,
    });
    expect(v.outcome).toBe("fail");
    expect(v.findings.some((f) => f.message.includes("broke everything"))).toBe(true);
    await rm(join(repo, "broken.test.mjs"));
  });
});

describe("gate suite", () => {
  it("aggregates verdicts, persists them, and synthesizes bounded repair feedback", async () => {
    const persisted: GateVerdictView[] = [];
    const suite = new GateSuite(
      [
        {
          name: "lint",
          async run() {
            return { gate: "lint", outcome: "pass", findings: [] };
          },
        },
        {
          name: "tests",
          async run() {
            return {
              gate: "tests",
              outcome: "fail",
              findings: Array.from({ length: 12 }, (_, i) => ({
                dimension: "suite_failed",
                message: `assertion ${i} failed`,
              })),
            };
          },
        },
      ],
      async (_runId: RunId, v) => {
        persisted.push(v);
      },
      nullLogger,
    );
    const res = await suite.runAll({ workspacePath: repo, baseRef: "main", changedFiles: [], runId: RUN });
    expect(res.passed).toBe(false);
    expect(persisted).toHaveLength(2);
    // Signal discipline: max 5 findings per failed gate in the feedback.
    expect(res.repairFeedback.split("\n")).toHaveLength(5);
    expect(res.error?.code).toBe("gates.failed");
  });

  it("a crashing gate becomes a fail verdict, never an unhandled throw", async () => {
    const suite = new GateSuite(
      [
        {
          name: "typecheck",
          async run(): Promise<GateVerdictView> {
            throw new Error("tsc binary vanished");
          },
        },
      ],
      async () => {},
      nullLogger,
    );
    const res = await suite.runAll({ workspacePath: repo, baseRef: "main", changedFiles: [], runId: RUN });
    expect(res.passed).toBe(false);
    expect(res.verdicts[0]?.findings[0]?.dimension).toBe("gate_crashed");
  });
});
