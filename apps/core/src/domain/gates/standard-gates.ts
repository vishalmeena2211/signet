// Phase 0 gates. Each is command-based against the workspace, diff-aware
// where possible, and reports specific findings — never walls of output.
//
// The tests gate implements the constitution's fail-then-pass discipline:
//   1. canonical tests come from the BASE ref (never the agent's worktree);
//   2. the agent's new/changed tests must FAIL on base code (falsifiable)
//      and PASS on the changed code — a test that passes on both proves
//      nothing and is rejected.

import { join } from "node:path";
import { access } from "node:fs/promises";
import type { Gate, GateContext } from "./gate-runner.js";
import { runCommand, topLines } from "./gate-runner.js";
import type { GateVerdictView } from "@signet/contracts";
import { detectEcosystem, isTestFile, runnerMissing, suitePassed } from "./ecosystems.js";

/** What the tests check says when it cannot run a repo's tests: plainly, never silently. */
const RUNS = "Signet runs tests for JavaScript and TypeScript (a test script in package.json), Python (pytest), Go and Rust.";

const TIMEOUT = 120_000;

export function typecheckGate(): Gate {
  return {
    name: "typecheck",
    async run(ctx: GateContext): Promise<GateVerdictView> {
      try {
        await access(join(ctx.workspacePath, "tsconfig.json"));
      } catch {
        return { gate: "typecheck", outcome: "skipped", findings: [] };
      }
      const res = await runCommand("npx", ["tsc", "--noEmit"], ctx.workspacePath, TIMEOUT);
      if (res.code === 0) return { gate: "typecheck", outcome: "pass", findings: [] };
      const lines = topLines(res.stdout + res.stderr, /error TS\d+/, 8);
      return {
        gate: "typecheck",
        outcome: "fail",
        findings: lines.map((l) => ({ dimension: "type_error", message: l })),
      };
    },
  };
}

export function lintGate(): Gate {
  return {
    name: "lint",
    async run(ctx: GateContext): Promise<GateVerdictView> {
      // Diff-scoped: lint only changed JS/TS files; absent config = skip.
      const targets = ctx.changedFiles.filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f));
      if (targets.length === 0) return { gate: "lint", outcome: "skipped", findings: [] };
      const res = await runCommand("npx", ["oxlint", ...targets], ctx.workspacePath, TIMEOUT);
      if (res.code === 0) return { gate: "lint", outcome: "pass", findings: [] };
      const lines = topLines(res.stdout + res.stderr, /warning|error/i, 8);
      return {
        gate: "lint",
        outcome: "fail",
        findings: lines.map((l) => ({ dimension: "lint", message: l })),
      };
    },
  };
}

export interface TestsGateDeps {
  /** Run a command in a temporary checkout of the BASE ref with the given extra files overlaid. */
  runOnBase: (input: {
    workspacePath: string;
    baseRef: string;
    overlayFiles: string[]; // agent's test files, copied onto base
    cmd: string;
    args: string[];
  }) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export function testsGate(deps: TestsGateDeps): Gate {
  return {
    name: "tests",
    async run(ctx: GateContext): Promise<GateVerdictView> {
      const eco = await detectEcosystem(ctx.workspacePath);
      if (!eco || "none" in eco.tests) {
        // Skipped, and saying why: a silent skip made every promise unprovable with
        // nothing on screen to explain it.
        return {
          gate: "tests",
          outcome: "skipped",
          findings: [{ dimension: "no_runner", message: eco && "none" in eco.tests ? `${eco.tests.none} ${RUNS}` : `No test suite Signet knows how to run was found. ${RUNS}` }],
        };
      }
      const runner = eco.tests;

      // 1) full suite on the changed workspace must pass
      const onChanged = await runCommand(runner.cmd, runner.args, ctx.workspacePath, TIMEOUT);
      if (!suitePassed(eco.name, onChanged.code)) {
        // A missing runner (127, or pytest not installed) is the ENVIRONMENT, not the code,
        // and no amount of rewriting tests will fix it — the first real run spent three
        // repairs and a restart discovering that. The dimension is what tells the run
        // machine to escalate at once instead of repairing.
        if (runnerMissing(eco.name, onChanged.code, onChanged.stdout + onChanged.stderr)) {
          return {
            gate: "tests",
            outcome: "fail",
            findings: [
              {
                dimension: "environment",
                message:
                  `\`${runner.shown}\` could not start in the workspace ` +
                  `(${onChanged.code === 127 ? "command not found" : "pytest is not installed"}): the test runner is not ` +
                  `installed there, so nothing was verified. ` +
                  `This is not something the agent can fix by changing code.`,
              },
            ],
          };
        }
        const lines = topLines(onChanged.stdout + onChanged.stderr, /(fail|✗|×|error)/i, 8);
        return {
          gate: "tests",
          outcome: "fail",
          findings: lines.length
            ? lines.map((l) => ({ dimension: "suite_failed", message: l }))
            : [{ dimension: "suite_failed", message: `exit ${onChanged.code}` }],
        };
      }

      // 2) falsifiability: agent-authored test changes must FAIL against base.
      //
      // Only when a SOURCE file also changed. Falsifiability proves that a test exercises
      // the NEW behaviour — so with no new behaviour there is nothing to falsify, and
      // demanding it blocks two kinds of legitimate work:
      //
      //   · Rewriting a test's style while preserving every assertion. It passes before
      //     and after by definition. A live run was killed by this: the task was
      //     "convert cart.test.mjs to node:test style", and the gate reported the tests
      //     "prove nothing about this change" — correct by its own rule, and the wrong
      //     conclusion.
      //   · Adding tests to code that already works. The new test passes on base because
      //     the behaviour was already there; covering it is the entire point.
      //
      // Anything that changes behaviour still has to prove it, which is where the check
      // earns its keep.
      const isTest = isTestFile;
      const testFiles = ctx.changedFiles.filter(isTest);
      const sourceFiles = ctx.changedFiles.filter((f) => !isTest(f));

      if (testFiles.length > 0 && sourceFiles.length === 0) {
        // Passed, and says why the strongest part of this gate did not apply — a silent
        // exemption is how a guard quietly stops guarding.
        return {
          gate: "tests",
          outcome: "pass",
          findings: [
            {
              dimension: "fail_then_pass",
              message:
                "Only test files changed, so falsifiability was not checked: there is no new " +
                "behaviour for a test to fail against. The suite passes.",
            },
          ],
        };
      }

      if (testFiles.length > 0) {
        const onBase = await deps.runOnBase({
          workspacePath: ctx.workspacePath,
          baseRef: ctx.baseRef,
          overlayFiles: testFiles,
          cmd: runner.cmd,
          args: runner.args,
        });
        if (suitePassed(eco.name, onBase.code)) {
          return {
            gate: "tests",
            outcome: "fail",
            findings: [
              {
                dimension: "fail_then_pass",
                message:
                  "new tests PASS on the unchanged base code — they prove nothing about this change. " +
                  "Write tests that fail before the change and pass after.",
              },
            ],
          };
        }
      }

      return { gate: "tests", outcome: "pass", findings: [] };
    },
  };
}
