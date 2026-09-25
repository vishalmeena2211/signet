// Rule compiler — turns a CONFIRMED rule's `check` into an executable scan
// over the CHANGED files only (delta-scoped, grandfathered: the backlog is
// never gated, only new/changed lines). A violation is a finding with the
// offending file:line; the gate aggregates them.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deltaE, findColors } from "../learner/color.js";
import type { Rule, RuleCheck } from "@signet/contracts";

export interface RuleViolation {
  ruleId: string;
  statement: string;
  file: string;
  line: number;
  detail: string;
}

interface DiffLine {
  file: string;
  line: number; // line number in the new file
  text: string;
}

/**
 * Run one rule's check against added/changed lines. `addedLines` is the set of
 * lines introduced by the diff — grandfathering falls out of only inspecting
 * these, never the whole file.
 */
export function runRuleCheck(rule: Rule, addedLines: DiffLine[]): RuleViolation[] {
  const check = rule.check;
  if (!check) return [];
  const out: RuleViolation[] = [];

  switch (check.type) {
    case "forbid_value": {
      const target = check.value.toLowerCase();
      for (const dl of addedLines) {
        for (const hit of findColors(dl.text)) {
          if (hit.color.hex === target) {
            out.push({
              ruleId: rule.id,
              statement: rule.statement,
              file: dl.file,
              line: dl.line,
              detail: `introduces ${check.value} (${hit.raw})`,
            });
          }
        }
      }
      break;
    }
    case "palette_conformance": {
      const allowed = check.allowedHexes.map((h) => h.toLowerCase());
      for (const dl of addedLines) {
        for (const hit of findColors(dl.text)) {
          const nearest = Math.min(...allowed.map((a) => deltaE(hit.color.hex, a)));
          if (nearest > check.maxDeltaE) {
            out.push({
              ruleId: rule.id,
              statement: rule.statement,
              file: dl.file,
              line: dl.line,
              detail: `${hit.raw} is ΔE ${Math.round(nearest)} from the nearest allowed color`,
            });
          }
        }
      }
      break;
    }
    case "forbid_asset": {
      // asset basename referenced in an added line
      const base = check.assetPath.split("/").pop() ?? check.assetPath;
      for (const dl of addedLines) {
        if (dl.text.includes(base)) {
          out.push({
            ruleId: rule.id,
            statement: rule.statement,
            file: dl.file,
            line: dl.line,
            detail: `references legacy asset ${check.assetPath}`,
          });
        }
      }
      break;
    }
    default: {
      const _exhaustive: never = check;
      void _exhaustive;
    }
  }

  // honor exceptions: drop violations under an excepted path
  return out.filter((v) => !rule.exceptions.some((ex) => v.file.startsWith(ex.path.replace(/\/$/, ""))));
}

/**
 * Parse `git diff` unified output into added lines with new-file line numbers.
 * Only '+' lines (excluding the +++ header) count as "added".
 */
export function parseAddedLines(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let file = "";
  let newLineNo = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      file = raw.slice(6);
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /\+(\d+)/.exec(raw);
      newLineNo = m ? Number(m[1]) : 0;
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      out.push({ file, line: newLineNo, text: raw.slice(1) });
      newLineNo++;
    } else if (!raw.startsWith("-")) {
      newLineNo++;
    }
  }
  return out;
}

export interface RuleCheckDeps {
  diffAddedLines: (workspacePath: string, baseRef: string) => Promise<DiffLine[]>;
}

export async function runConfirmedRules(
  rules: Rule[],
  workspacePath: string,
  baseRef: string,
  deps: RuleCheckDeps,
): Promise<RuleViolation[]> {
  const enforceable = rules.filter((r) => r.status === "CONFIRMED" && r.check !== null);
  if (enforceable.length === 0) return [];
  const added = await deps.diffAddedLines(workspacePath, baseRef);
  return enforceable.flatMap((r) => runRuleCheck(r, added));
}

export type { DiffLine };
export { readFile, join }; // re-export for the git-backed deps impl
