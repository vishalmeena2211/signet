// Gate execution framework. Gates run in PARALLEL in the core's context (the
// agent cannot observe or influence them), produce per-dimension verdicts, and
// their combined failure text becomes the repair feedback the next agent
// attempt receives. Phase 0 gates: typecheck, lint, tests(fail-then-pass).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  nonRecoverable,
  recoverable,
  type GateVerdictView,
  type RunId,
  type SignetError,
} from "@signet/contracts";
import type { Logger } from "../runtime/logger.js";

const pexec = promisify(execFile);

export interface GateContext {
  workspacePath: string;
  baseRef: string;
  changedFiles: string[];
  runId: RunId;
  /** Which increment this run belongs to — the conformance gate loads its approved design. */
  incrementId?: string;
}

export interface Gate {
  name: GateVerdictView["gate"];
  run(ctx: GateContext): Promise<GateVerdictView>;
}

export interface GateSuiteResult {
  passed: boolean;
  verdicts: GateVerdictView[];
  repairFeedback: string;
  error: SignetError | null;
}

export class GateSuite {
  constructor(
    private readonly gates: Gate[],
    private readonly persistVerdict: (runId: RunId, v: GateVerdictView) => Promise<void>,
    private readonly log: Logger,
  ) {}

  async runAll(ctx: GateContext): Promise<GateSuiteResult> {
    const verdicts = await Promise.all(
      this.gates.map(async (g) => {
        const log = this.log.child({ runId: ctx.runId, phase: "GATES" });
        try {
          const v = await g.run(ctx);
          log.info("gate.verdict", { gate: g.name, outcome: v.outcome });
          await this.persistVerdict(ctx.runId, v);
          return v;
        } catch (e) {
          const v: GateVerdictView = {
            gate: g.name,
            outcome: "fail",
            findings: [{ dimension: "gate_crashed", message: String(e).slice(0, 500) }],
          };
          await this.persistVerdict(ctx.runId, v).catch(() => {});
          return v;
        }
      }),
    );

    const failed = verdicts.filter((v) => v.outcome === "fail");
    if (failed.length === 0) {
      return { passed: true, verdicts, repairFeedback: "", error: null };
    }
    // Signal discipline: top findings only, one line each, gate-prefixed.
    const repairFeedback = failed
      .flatMap((v) => v.findings.slice(0, 5).map((f) => `[${v.gate}] ${f.dimension}: ${f.message}${f.location ? ` (${f.location})` : ""}`))
      .join("\n");
    // An ENVIRONMENT failure is not repairable by definition: the tools are missing, so
    // the agent could rewrite the code perfectly and the gate would still fail. Returning
    // it as non-recoverable escalates immediately instead of spending the repair budget
    // on something no code change can affect.
    const environmental = failed.filter((v) => v.findings.some((f) => f.dimension === "environment"));
    if (environmental.length > 0) {
      return {
        passed: false,
        verdicts,
        repairFeedback,
        error: nonRecoverable(
          "gates.environment",
          environmental[0]?.findings.find((f) => f.dimension === "environment")?.message ??
            `${environmental.map((v) => v.gate).join(", ")} could not run`,
        ),
      };
    }

    return {
      passed: false,
      verdicts,
      repairFeedback,
      error: recoverable("gates.failed", `${failed.map((v) => v.gate).join(", ")} failed`),
    };
  }
}

// ── helpers for command-based gates ─────────────────────────────────────────

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await pexec(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** Extract up to n distinct non-empty lines matching a filter — verdict findings. */
export function topLines(text: string, filter: RegExp, n: number): string[] {
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && filter.test(t)) {
      seen.add(t.slice(0, 300));
      if (seen.size >= n) break;
    }
  }
  return [...seen];
}
