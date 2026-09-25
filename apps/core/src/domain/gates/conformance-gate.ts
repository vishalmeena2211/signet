// The conformance gate, live. Loads the increment's APPROVED design-of-record
// and judges the diff against it. Unlike the rules gate (warn-first), a
// conformance failure BLOCKS: the design is the thing a human signed, so
// diverging from it is not advice — and the findings become repair feedback,
// so the agent gets told exactly how it diverged.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DesignOfRecord, GateVerdictView } from "@signet/contracts";
import type { Gate, GateContext } from "./gate-runner.js";
import { parseAddedLines, type DiffLine } from "./rule-check.js";
import { analyzeConformance, type VlmJudge } from "./conformance.js";

const pexec = promisify(execFile);

export interface ConformanceGateDeps {
  loadDesign: (incrementId: string) => Promise<DesignOfRecord | null>;
  vlm?: VlmJudge;
  /** Optional render step; when absent the gate runs its deterministic path only. */
  renderBuilt?: (workspacePath: string) => Promise<string | null>;
}

async function gitDiffAddedLines(workspacePath: string, baseRef: string): Promise<DiffLine[]> {
  const { stdout } = await pexec("git", ["diff", `${baseRef}...HEAD`, "--unified=0"], {
    cwd: workspacePath,
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseAddedLines(stdout);
}

export function conformanceGate(deps: ConformanceGateDeps): Gate {
  return {
    name: "conformance",
    async run(ctx: GateContext): Promise<GateVerdictView> {
      if (!ctx.incrementId) return { gate: "conformance", outcome: "skipped", findings: [] };
      const design = await deps.loadDesign(ctx.incrementId);
      if (!design) return { gate: "conformance", outcome: "skipped", findings: [] };

      const addedLines = await gitDiffAddedLines(ctx.workspacePath, ctx.baseRef);
      const builtImagePath = deps.renderBuilt ? await deps.renderBuilt(ctx.workspacePath) : null;

      const result = await analyzeConformance({
        design,
        addedLines,
        changedFiles: ctx.changedFiles,
        ...(builtImagePath ? { builtImagePath } : {}),
        ...(deps.vlm ? { vlm: deps.vlm } : {}),
      });

      if (result.overallPassed) return { gate: "conformance", outcome: "pass", findings: [] };

      const failed = result.dimensions.filter((d) => !d.passed);
      return {
        gate: "conformance",
        outcome: "fail",
        findings: failed.flatMap((d) =>
          d.evidence.length > 0
            ? d.evidence.slice(0, 5).map((e) => ({
                dimension: d.dimension,
                message: `${d.detail} — ${e}`,
              }))
            : [{ dimension: d.dimension, message: d.detail }],
        ),
      };
    },
  };
}
