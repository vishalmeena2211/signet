// The promises check, as a gate.
//
// It never FAILS a run. An unproven promise is not something the repair loop should
// chase blindly — the fix is a specific missing test, and the person deciding whether
// to land the work is the one who should ask for it. So it reports "warn", and it is the
// seal that refuses to land unproven work without an explicit choice.

import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GateVerdictView } from "@signet/contracts";
import type { Gate, GateContext } from "./gate-runner.js";
import { extractPromises, isTestFile, parseProofClaims, parseUnifiedDiff, verifyProofs } from "./promises.js";

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
      const changes = parseUnifiedDiff(patch);
      // The changed test files as they now stand, so a test that already existed and was
      // edited here can be found and its body checked against the change.
      const testContents = new Map<string, string>();
      // Changed test files, and any test file a claim names — an untouched one may hold
      // the test that proves a "still works" promise. Only relative paths inside the
      // workspace are read: a claim is the agent's word, not a path to trust.
      const named = (claims ?? []).map((c) => c.testFile).filter((f): f is string => typeof f === "string");
      for (const f of new Set([...changes.keys(), ...named])) {
        if (!isTestFile(f) || isAbsolute(f) || normalize(f).startsWith("..")) continue;
        const text = await readOr(join(ctx.workspacePath, f), "");
        if (text !== "") testContents.set(f, text);
      }
      const proofs = verifyProofs({ promises, claims, changes, testContents });

      // More promises than the verdict can list: the rest are named as unchecked, never
      // dropped, so the seal holds on them instead of not knowing they exist.
      const LISTED = 39;
      const overflow = proofs.length > LISTED + 1 ? proofs.length - LISTED : 0;
      const listed = overflow > 0 ? proofs.slice(0, LISTED) : proofs;
      return {
        gate: "promises",
        outcome: proofs.every((p) => p.proven) && overflow === 0 ? "pass" : "warn",
        findings: [
          ...listed.map((p) => ({
            dimension: p.proven ? "proven" : "unproven",
            message: p.promise,
            ...(p.reason ? { location: p.reason } : p.test ? { location: `test “${p.test}”` } : {}),
            proof: { test: p.test, testFile: p.testFile, codeFile: p.codeFile, codeLines: p.codeLines, ...(p.changedTest ? { changedTest: true } : {}), ...(p.existingTest ? { existingTest: true } : {}) },
          })),
          ...(overflow > 0
            ? [{ dimension: "unproven", message: `${overflow} more promises, too many to check one by one. A step with this many promises should be split.`, location: "Not checked: split the step." }]
            : []),
        ],
      };
    },
  };
}
