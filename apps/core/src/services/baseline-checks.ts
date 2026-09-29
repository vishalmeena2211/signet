// The checks, run once against main before any work is judged by them.
//
// Every gate assumes its tools work in this repo. When they do not — no test runner
// installed, a test command that was already failing — the first step to run discovers
// it, and the failure is blamed on the agent's change. The first real run against a
// package spent three repairs and a restart "fixing" correct tests because the runner
// exited 127. Running the same checks against the base branch first answers the
// question the right way round: can these checks run here, and do they pass before
// anything has changed?
//
// Uses the real gates on an exported copy of the base ref, so a baseline pass means
// exactly what a gate pass means, not something approximately similar.

import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  BaselineReportSchema,
  RunIdSchema,
  type BaselineCheck,
  type BaselineReport,
  type GateVerdictView,
} from "@signet/contracts";
import { z } from "zod";
import type { Gate } from "../domain/gates/gate-runner.js";
import { detectEcosystem } from "../domain/gates/ecosystems.js";

const pexec = promisify(execFile);

export interface BaselineDeps {
  typecheck: Gate;
  tests: Gate;
  /** Where the last report per repo is kept, so Health can show it without re-running. */
  storePath: string;
}

export class BaselineChecks {
  constructor(private readonly deps: BaselineDeps) {}

  async run(repo: { path: string; label: string }, ref: string): Promise<BaselineReport> {
    const { stdout: sha } = await pexec("git", ["rev-parse", ref], { cwd: repo.path });
    const sandbox = await mkdtemp(join(tmpdir(), "signet-baseline-"));
    try {
      const tar = join(sandbox, "base.tar");
      await pexec("git", ["archive", "--format=tar", "-o", tar, ref], { cwd: repo.path });
      await pexec("tar", ["-xf", tar, "-C", sandbox]);
      await rm(tar, { force: true });
      // The developer's installed dependencies, cloned copy-on-write where the filesystem
      // allows (instant, isolated), symlinked otherwise — the same order as a worktree.
      const modules = join(repo.path, "node_modules");
      await pexec("cp", ["-Rc", modules, join(sandbox, "node_modules")]).catch(() =>
        pexec("ln", ["-s", modules, join(sandbox, "node_modules")]).catch(() => undefined),
      );

      const ctx = {
        workspacePath: sandbox,
        baseRef: ref,
        changedFiles: [],
        runId: RunIdSchema.parse(randomUUID()),
      };
      const typecheck = await timed(() => this.deps.typecheck.run(ctx));
      const tests = await timed(() => this.deps.tests.run(ctx));
      const eco = await detectEcosystem(sandbox);
      const testCommand = eco && !("none" in eco.tests) ? eco.tests.shown : "npm test";
      const noSuite = tests.v.findings.find((f) => f.dimension === "no_runner")?.message ?? "No test suite Signet knows how to run was found.";

      const report = BaselineReportSchema.parse({
        repoPath: repo.path,
        repoLabel: repo.label,
        ref,
        sha: sha.trim(),
        checkedAt: new Date().toISOString(),
        checks: [
          toCheck("typecheck", eco?.name === "go" ? "go vet ./..." : eco?.name === "rust" ? "cargo check --all-targets" : "npx tsc --noEmit", typecheck, "No tsconfig.json, go.mod or Cargo.toml, so there are no types to check."),
          {
            check: "lint",
            command: null,
            outcome: "skipped",
            durationMs: 0,
            detail: "Lint judges only the lines a step changes, so there is nothing to check on main. Existing warnings are the starting point.",
          },
          toCheck("tests", testCommand, tests, noSuite),
        ],
      });
      await this.save(report);
      return report;
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  }

  async last(repoPath: string): Promise<BaselineReport | null> {
    return (await this.load())[repoPath] ?? null;
  }

  private async load(): Promise<Record<string, BaselineReport>> {
    try {
      const raw = JSON.parse(await readFile(this.deps.storePath, "utf8")); // signet-policy-allow: raw-json-parse -- validated by the record schema on the next line
      const parsed = z.record(z.string(), BaselineReportSchema).safeParse(raw);
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  private async save(report: BaselineReport): Promise<void> {
    const all = await this.load();
    all[report.repoPath] = report;
    await mkdir(dirname(this.deps.storePath), { recursive: true });
    await writeFile(this.deps.storePath, JSON.stringify(all, null, 2), "utf8");
  }
}

async function timed(fn: () => Promise<GateVerdictView>): Promise<{ v: GateVerdictView; ms: number }> {
  const started = Date.now();
  const v = await fn();
  return { v, ms: Date.now() - started };
}

/** A gate verdict, read as "can this run here, and does it pass on main". */
export function toCheck(
  check: "typecheck" | "tests",
  command: string,
  r: { v: GateVerdictView; ms: number },
  skippedWhy: string,
): BaselineCheck {
  const env = r.v.findings.find((f) => f.dimension === "environment");
  if (env) return { check, command, outcome: "cannot_run", durationMs: r.ms, detail: env.message };
  if (r.v.outcome === "skipped") return { check, command: null, outcome: "skipped", durationMs: r.ms, detail: skippedWhy };
  if (r.v.outcome === "fail") {
    const first = r.v.findings[0]?.message;
    return {
      check,
      command,
      outcome: "fail",
      durationMs: r.ms,
      detail: `Already failing on main${first ? `: ${first}` : ""}. Every step would inherit this.`,
    };
  }
  return { check, command, outcome: "pass", durationMs: r.ms, detail: null };
}
