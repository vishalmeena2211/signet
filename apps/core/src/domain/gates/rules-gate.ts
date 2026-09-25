// The rules gate — enforces the confirmed design constitution against the diff.
// Warn-first by policy: findings surface as a `warn` verdict unless the rule's
// confidence is high AND it is not freshly reconfirmed. Delta-scoped and
// grandfathered via runConfirmedRules (only added lines are inspected).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Gate, GateContext } from "./gate-runner.js";
import { parseAddedLines, runConfirmedRules, type DiffLine } from "./rule-check.js";
import type { GateVerdictView, Rule } from "@signet/contracts";

const pexec = promisify(execFile);

export interface RulesGateDeps {
  /** Confirmed rules for the target repo. */
  loadConfirmedRules: () => Promise<Rule[]>;
  /** Whether a violated rule should BLOCK (fail) vs WARN. Default: warn-first. */
  blockPolicy?: (rule: Rule) => boolean;
}

async function gitDiffAddedLines(workspacePath: string, baseRef: string): Promise<DiffLine[]> {
  const { stdout } = await pexec("git", ["diff", `${baseRef}...HEAD`, "--unified=0"], {
    cwd: workspacePath,
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseAddedLines(stdout);
}

export function rulesGate(deps: RulesGateDeps): Gate {
  const shouldBlock = deps.blockPolicy ?? (() => false); // warn-first default
  return {
    name: "rules",
    async run(ctx: GateContext): Promise<GateVerdictView> {
      const rules = await deps.loadConfirmedRules();
      if (rules.length === 0) return { gate: "rules", outcome: "skipped", findings: [] };

      const violations = await runConfirmedRules(rules, ctx.workspacePath, ctx.baseRef, {
        diffAddedLines: gitDiffAddedLines,
      });
      if (violations.length === 0) return { gate: "rules", outcome: "pass", findings: [] };

      const ruleById = new Map<string, Rule>(rules.map((r) => [r.id, r]));
      const anyBlocking = violations.some((v) => {
        const r = ruleById.get(v.ruleId);
        return r ? shouldBlock(r) : false;
      });

      return {
        gate: "rules",
        outcome: anyBlocking ? "fail" : "warn",
        findings: violations.slice(0, 20).map((v) => ({
          dimension: "constitution",
          message: `${v.detail} — ${v.statement}`,
          location: `${v.file}:${v.line}`,
        })),
      };
    },
  };
}
