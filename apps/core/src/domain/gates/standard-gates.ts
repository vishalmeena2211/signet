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

const TIMEOUT = 120_000;

async function detectRunner(workspacePath: string): Promise<{ cmd: string; args: string[] } | null> {
  // Phase 0 supports node projects with a test script; the fixture repo and
  // most TS targets fit. Extended per-ecosystem detection arrives with Phase 2.
  try {
    await access(join(workspacePath, "package.json"));
    return { cmd: "npm", args: ["test", "--silent"] };
  } catch {
    return null;
  }
}

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
      const runner = await detectRunner(ctx.workspacePath);
      if (!runner) return { gate: "tests", outcome: "skipped", findings: [] };

      // 1) full suite on the changed workspace must pass
      const onChanged = await runCommand(runner.cmd, runner.args, ctx.workspacePath, TIMEOUT);
      if (onChanged.code !== 0) {
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
      const isTest = (f: string): boolean => /\.(spec|test)\.(c|m)?[jt]sx?$/.test(f);
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
        if (onBase.code === 0) {
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
