// Read models for watching and judging a step: what the agent did, and which promises
// are proven. Kept apart from ConsoleViews because both lean on files outside the
// database — the per-run activity trace and the worktree — and ConsoleViews is pure
// Prisma.

import {
  EscalationStateSchema,
  GateVerdictViewSchema,
  PromisesViewSchema,
  type PromisesView,
  type RunWorkView,
} from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";
import { creditTestsCheck, extractPromises } from "../domain/gates/promises.js";
import { buildWorkView, type AgentWorkLog } from "./agent-work.js";

export class WorkViews {
  constructor(
    private readonly db: PrismaClient,
    private readonly log: AgentWorkLog,
  ) {}

  /** null when the run does not exist. */
  async runWork(runId: string): Promise<RunWorkView | null> {
    const run = await this.db.run.findUnique({
      where: { id: runId },
      select: { workspacePath: true, increment: { select: { id: true, declaredSurface: true } } },
    });
    if (!run) return null;
    const open = await this.db.escalation.findMany({
      where: { incrementId: run.increment.id, status: "RAISED" },
      select: { stateJson: true },
    });
    const reached = open.flatMap((e) => {
      const st = EscalationStateSchema.safeParse(JSON.parse(e.stateJson)); // signet-policy-allow: raw-json-parse -- validated by EscalationStateSchema on this line
      return st.success && st.data.status === "RAISED" ? (st.data.fence?.outside ?? []) : [];
    });
    return buildWorkView({
      runId,
      actions: await this.log.read(runId),
      surface: run.increment.declaredSurface,
      workspacePath: run.workspacePath,
      reached,
    });
  }

  /**
   * Each promise in "done when" with its proof, from the latest run's promises check.
   * A step whose latest run was never checked lists its promises unproven and says why,
   * rather than showing nothing and implying there was nothing to prove.
   */
  async promises(incrementId: string): Promise<PromisesView> {
    const inc = await this.db.increment.findUnique({ where: { id: incrementId }, select: { acceptanceMd: true } });
    const lastRun = await this.db.run.findFirst({
      where: { incrementId },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    const verdict = lastRun
      ? await this.db.gateVerdict.findFirst({
          where: { runId: lastRun.id, gate: "promises" },
          orderBy: { recordedAt: "desc" },
        })
      : null;

    if (!verdict) {
      return PromisesViewSchema.parse({
        checked: false,
        promises: extractPromises(inc?.acceptanceMd ?? "").map((promise) => ({
          promise,
          proven: false,
          test: null,
          testFile: null,
          codeFile: null,
          codeLines: null,
          reason: lastRun
            ? "Not checked: this step was built before promises were checked against tests."
            : "Not built yet.",
        })),
      });
    }

    const v = GateVerdictViewSchema.parse({
      gate: verdict.gate,
      outcome: verdict.outcome,
      findings: JSON.parse(verdict.findingsJson), // signet-policy-allow: raw-json-parse -- schema-validated on this line
    });
    // The tests check of the same run: when it ran the suite and it passed, a promise
    // that only says "the suite passes", or one kept by an untouched existing test, has
    // its proof.
    const tests = await this.db.gateVerdict.findFirst({
      where: { runId: verdict.runId, gate: "tests" },
      orderBy: { recordedAt: "desc" },
      select: { outcome: true },
    });
    return PromisesViewSchema.parse({
      checked: true,
      promises: creditTestsCheck(v.findings.map((f) => ({
        promise: f.message,
        proven: f.dimension === "proven",
        test: f.proof?.test ?? null,
        testFile: f.proof?.testFile ?? null,
        codeFile: f.proof?.codeFile ?? null,
        codeLines: f.proof?.codeLines ?? null,
        ...(f.proof?.changedTest ? { changedTest: true } : {}),
        ...(f.proof?.existingTest ? { existingTest: true } : {}),
        reason: f.dimension === "proven" ? null : (f.location ?? "No test proves this."),
      })), tests?.outcome === "pass"),
    });
  }

  /** What the seal holds on: the unproven promises of a CHECKED run. Unchecked runs hold nothing. */
  async unproven(incrementId: string): Promise<string[]> {
    const view = await this.promises(incrementId);
    return view.checked ? view.promises.filter((p) => !p.proven).map((p) => p.promise) : [];
  }
}
