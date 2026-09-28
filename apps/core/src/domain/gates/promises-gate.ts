// The promises check, as a gate.
//
// It never FAILS a run. An unproven promise is not something the repair loop should
// chase blindly — the fix is a specific missing test, and the person deciding whether
// to land the work is the one who should ask for it. So it reports "warn", and it is the
// seal that refuses to land unproven work without an explicit choice.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GateVerdictView } from "@signet/contracts";
import type { Gate, GateContext } from "./gate-runner.js";
import { extractPromises, parseProofClaims, parseUnifiedDiff, verifyProofs } from "./promises.js";

const pexec = promisify(execFile);

export const PROOFS_FILE = "proofs.md";

async function readOr(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

export function promisesGate(deps: { packsRoot: string }): Gate {
  return {
    name: "promises",
    async run(ctx: GateContext): Promise<GateVerdictView> {
      const packDir = join(deps.packsRoot, `run-${ctx.runId}`);
      const promises = extractPromises(await readOr(join(packDir, "acceptance.md"), ""));
      if (promises.length === 0) return { gate: "promises", outcome: "skipped", findings: [] };

      const closing = await readOr(join(packDir, PROOFS_FILE), "");
      const claims = closing === "" ? null : parseProofClaims(closing);
      const { stdout: patch } = await pexec("git", ["diff", "-U0", `${ctx.baseRef}...HEAD`], {
        cwd: ctx.workspacePath,
        maxBuffer: 20 * 1024 * 1024,
      });
      const proofs = verifyProofs({ promises, claims, changes: parseUnifiedDiff(patch) });

      return {
        gate: "promises",
        outcome: proofs.every((p) => p.proven) ? "pass" : "warn",
        findings: proofs.map((p) => ({
          dimension: p.proven ? "proven" : "unproven",
          message: p.promise,
          ...(p.reason ? { location: p.reason } : p.test ? { location: `test “${p.test}”` } : {}),
          proof: { test: p.test, testFile: p.testFile, codeFile: p.codeFile, codeLines: p.codeLines },
        })),
      };
    },
  };
}
