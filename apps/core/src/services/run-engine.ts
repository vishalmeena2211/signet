// RunEngine — executes one increment run through its phases. Decisions come
// from the pure run-machine; this class does the IO: journal-before-act,
// recovery points, worktree lifecycle, adapter sessions, gate invocation.
// It is deliberately ignorant of HTTP, Prisma, and process management.

import {
  IncrementPlanSchema,
  RunPhaseNameSchema,
  nonRecoverable,
  recoverable,
  type AdapterEvent,
  type IncrementId,
  type ModelUsage,
  type RunId,
  type RunPhaseName,
  type SessionRef,
  type SignetError,
} from "@signet/contracts";
import { afterPhaseComplete, afterPhaseFailure, type RunDecision } from "../domain/runtime/run-machine.js";
import type { Logger } from "../domain/runtime/logger.js";
import type { TxPorts, UnitOfWork } from "../domain/runtime/ports.js";
import type { WorktreeHandle, WorktreeManager } from "../domain/runtime/worktree-manager.js";

/** What the engine needs from the Claude Code adapter (implemented in domain/adapter). */
export interface AgentDriver {
  plan(input: { packDir: string; workspacePath: string; signal?: AbortSignal }): Promise<
    { ok: true; plan: unknown; sessionRef: SessionRef; usage: ModelUsage[] } | { ok: false; error: SignetError }
  >;
  implement(input: {
    packDir: string;
    workspacePath: string;
    resumeSession: SessionRef | null;
    repairFeedback: string | null;
    signal?: AbortSignal;
    onEvent: (ev: AdapterEvent) => Promise<void>;
  }): Promise<{ ok: true; sessionRef: SessionRef } | { ok: false; error: SignetError }>;
}

/** What the engine needs from the gate executor (implemented in domain/gates). */
export interface GateRunner {
  runAll(input: {
    workspacePath: string;
    baseRef: string;
    changedFiles: string[];
    runId: RunId;
    incrementId: IncrementId;
  }): Promise<{ passed: true } | { passed: false; repairFeedback: string; error: SignetError }>;
}

/** What the engine needs from context-pack assembly (implemented in services/pack-assembler). */
export interface PackAssembler {
  assemble(input: { incrementId: IncrementId; runId: RunId; workspacePath: string | null }): Promise<{
    packDir: string;
    declaredSurface: string[];
  }>;
}

export interface ScopeChecker {
  check(planFiles: string[], declaredSurface: string[]): { inScope: true } | { inScope: false; outside: string[] };
}

/**
 * Where an increment's work goes. Optional on the engine: without it every run uses the
 * instance's configured repo, which is what every increment created before features
 * could name their own repo relies on.
 */
export interface RepoResolver {
  forIncrement(incrementId: IncrementId): Promise<{
    path: string;
    label: string;
    /**
     * False for a github repo, where merging needs a push. The run refuses BEFORE doing
     * any work — spending a model call on something that cannot be merged is worse than
     * saying no immediately.
     */
    canMerge: boolean;
  }>;
}

export interface RunEngineConfig {
  baseRef: string;
  maxRepairIterations: number;
  maxFreshRestarts: number;
}

export type RunOutcome =
  | { outcome: "succeeded" }
  | { outcome: "failed"; error: SignetError }
  | { outcome: "parked"; resumeAt: Date | null }
  | { outcome: "escalated"; question: string };

export class RunEngine {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly worktrees: WorktreeManager,
    private readonly agent: AgentDriver,
    private readonly gates: GateRunner,
    private readonly packs: PackAssembler,
    private readonly scope: ScopeChecker,
    private readonly cfg: RunEngineConfig,
    private readonly log: Logger,
    private readonly repos?: RepoResolver,
  ) {}

  /** The repo this increment builds into, and whether finishing there is possible. */
  private async repoFor(incrementId: IncrementId): Promise<{ path: string | undefined; error: SignetError | null }> {
    if (!this.repos) return { path: undefined, error: null };
    const repo = await this.repos.forIncrement(incrementId);
    if (!repo.canMerge) {
      return {
        path: undefined,
        error: nonRecoverable(
          "repo.cannot_merge",
          `${repo.label} is a GitHub repository. Signet can plan against it, but cannot merge into it yet, so this step would never finish. Point the feature at a local clone instead.`,
        ),
      };
    }
    return { path: repo.path, error: null };
  }

  /** Execute a run from a given phase (fresh start or crash-resume). */
  async execute(
    runId: RunId,
    incrementId: IncrementId,
    startPhase: RunPhaseName,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<RunOutcome> {
    this.signals.set(runId, signal);
    const log = this.log.child({ runId, incrementId });
    let phase: RunPhaseName = startPhase;
    let phaseAttempt = attempt;
    let packDir: string | null = null;
    let declaredSurface: string[] = [];
    let handle: WorktreeHandle | null = null;
    let repairFeedback: string | null = null;

    // Rebuild transient state when resuming past ASSEMBLE_PACK/CREATE_WORKSPACE.
    if (startPhase !== "ASSEMBLE_PACK") {
      const pack = await this.packs.assemble({ incrementId, runId, workspacePath: null });
      packDir = pack.packDir;
      declaredSurface = pack.declaredSurface;
      const repo = await this.repoFor(incrementId);
      if (repo.error) return { outcome: "failed", error: repo.error };
      const acq = await this.worktrees.acquire(incrementId, this.cfg.baseRef, repo.path);
      if (!acq.ok) return this.fail(runId, acq.error);
      handle = acq.value;
    }

    for (;;) {
      await this.enterPhase(runId, phase, phaseAttempt);
      log.info("phase.entered", { phase, attempt: phaseAttempt });

      const result = await this.runPhase({
        runId,
        incrementId,
        phase,
        packDir,
        declaredSurface,
        handle,
        repairFeedback,
        setPack: (d, s) => {
          packDir = d;
          declaredSurface = s;
        },
        setHandle: (h) => {
          handle = h;
        },
      });

      let decision: RunDecision;
      if (result.ok) {
        await this.completePhase(runId, phase, phaseAttempt);
        decision = afterPhaseComplete(phase);
        repairFeedback = null;
      } else {
        const row = await this.incrementRow(incrementId);
        decision = afterPhaseFailure({
          phase,
          error: result.error,
          repairAttempt: row.repairAttempt,
          freshRestarts: row.freshRestarts,
          maxRepairIterations: this.cfg.maxRepairIterations,
          maxFreshRestarts: this.cfg.maxFreshRestarts,
          quotaResetsAt: result.quotaResetsAt ?? null,
        });
        repairFeedback = result.repairFeedback ?? null;
      }

      switch (decision.kind) {
        case "enter_phase":
          phase = decision.phase;
          phaseAttempt = decision.attempt;
          continue;
        case "repair":
          await this.bumpRepair(incrementId, decision.attempt);
          log.info("run.repair", { attempt: decision.attempt });
          phase = "AGENT_IMPLEMENT";
          phaseAttempt = decision.attempt;
          continue;
        case "fresh_restart":
          await this.bumpRestart(incrementId);
          log.warn("run.fresh_restart", {});
          if (handle) await this.worktrees.release(handle, { removeWorktree: true });
          handle = null;
          repairFeedback = null;
          phase = "CREATE_WORKSPACE";
          phaseAttempt = 1;
          continue;
        case "succeed":
          await this.uow.run(async (tx) => {
            await tx.runs.setState(runId, { status: "SUCCEEDED" });
          });
          log.info("run.succeeded", {});
          return { outcome: "succeeded" };
        case "park":
          log.warn("run.parked", { resumeAt: decision.resumeAt?.toISOString() });
          return { outcome: "parked", resumeAt: decision.resumeAt };
        case "escalate":
          log.warn("run.escalated", {});
          return { outcome: "escalated", question: decision.question };
        case "fail":
          return this.fail(runId, decision.error);
        default:
          return this.fail(runId, nonRecoverable("engine.unknown_decision", "unreachable"));
      }
    }
  }

  // ── phase bodies ──────────────────────────────────────────────────────────

  private async runPhase(ctx: {
    runId: RunId;
    incrementId: IncrementId;
    phase: RunPhaseName;
    packDir: string | null;
    declaredSurface: string[];
    handle: WorktreeHandle | null;
    repairFeedback: string | null;
    setPack: (dir: string, surface: string[]) => void;
    setHandle: (h: WorktreeHandle) => void;
  }): Promise<
    { ok: true } | { ok: false; error: SignetError; repairFeedback?: string; quotaResetsAt?: Date | null }
  > {
    switch (ctx.phase) {
      case "ASSEMBLE_PACK": {
        const pack = await this.packs.assemble({
          incrementId: ctx.incrementId,
          runId: ctx.runId,
          workspacePath: ctx.handle?.path ?? null,
        });
        ctx.setPack(pack.packDir, pack.declaredSurface);
        return { ok: true };
      }
      case "CREATE_WORKSPACE": {
        const repo = await this.repoFor(ctx.incrementId);
        if (repo.error) return { ok: false as const, error: repo.error };
        const acq = await this.worktrees.acquire(ctx.incrementId, this.cfg.baseRef, repo.path);
        if (!acq.ok) return { ok: false, error: acq.error };
        ctx.setHandle(acq.value);
        await this.uow.run(async (tx) => {
          await tx.runs.setWorkspacePath(ctx.runId, acq.value.path);
        });
        return { ok: true };
      }
      case "AGENT_PLAN": {
        if (!ctx.packDir || !ctx.handle) return { ok: false, error: nonRecoverable("engine.state", "no pack/workspace") };
        const planSignal = this.signals.get(ctx.runId);
        const res = await this.agent.plan({
          packDir: ctx.packDir,
          workspacePath: ctx.handle.path,
          ...(planSignal ? { signal: planSignal } : {}),
        });
        if (!res.ok) return { ok: false, error: res.error };
        const parsed = IncrementPlanSchema.safeParse(res.plan);
        if (!parsed.success) {
          return { ok: false, error: recoverable("plan.unparseable", "agent plan failed schema validation") };
        }
        await this.uow.run(async (tx) => {
          await tx.runs.setSessionRef(ctx.runId, res.sessionRef);
          await tx.runs.recordUsage(ctx.runId, res.usage);
        });
        // Stash plan files in memory for SCOPE_CHECK via declaredSurface comparison.
        this.lastPlanFiles.set(ctx.runId, parsed.data.filesToTouch);
        return { ok: true };
      }
      case "SCOPE_CHECK": {
        const planFiles = this.lastPlanFiles.get(ctx.runId) ?? [];
        const verdict = this.scope.check(planFiles, ctx.declaredSurface);
        if (!verdict.inScope) {
          return {
            ok: false,
            error: nonRecoverable(
              "scope.outside_surface",
              `plan touches files outside the declared surface: ${verdict.outside.join(", ")}`,
            ),
          };
        }
        return { ok: true };
      }
      case "AGENT_IMPLEMENT": {
        if (!ctx.packDir || !ctx.handle) return { ok: false, error: nonRecoverable("engine.state", "no pack/workspace") };
        const row = await this.runRow(ctx.runId);
        let quotaResetsAt: Date | null = null;
        const implSignal = this.signals.get(ctx.runId);
        const res = await this.agent.implement({
          packDir: ctx.packDir,
          workspacePath: ctx.handle.path,
          resumeSession: row.sessionRef,
          repairFeedback: ctx.repairFeedback,
          ...(implSignal ? { signal: implSignal } : {}),
          onEvent: async (ev) => {
            if (ev.type === "usage_update" || ev.type === "completed") {
              await this.uow.run(async (tx) => {
                await tx.runs.recordUsage(ctx.runId, ev.perModel, ev.type === "completed" ? ev.totalCostUsd : undefined);
              });
            }
            if (ev.type === "session_started") {
              await this.uow.run(async (tx) => {
                await tx.runs.setSessionRef(ctx.runId, ev.sessionRef);
              });
            }
            if (ev.type === "limit_reached" && ev.resetsAt) {
              quotaResetsAt = new Date(ev.resetsAt);
            }
          },
        });
        if (!res.ok) return { ok: false, error: res.error, quotaResetsAt };
        await this.worktrees.commitAll(ctx.handle, `signet: increment ${ctx.incrementId} implement`);
        return { ok: true };
      }
      case "GATES": {
        if (!ctx.handle) return { ok: false, error: nonRecoverable("engine.state", "no workspace") };
        const changed = await this.worktrees.changedFiles(ctx.handle, this.cfg.baseRef);
        if (changed.length === 0) {
          return { ok: false, error: recoverable("gates.empty_diff", "agent produced no changes") };
        }
        const verdict = await this.gates.runAll({
          workspacePath: ctx.handle.path,
          baseRef: this.cfg.baseRef,
          changedFiles: changed,
          runId: ctx.runId,
          incrementId: ctx.incrementId,
        });
        if (!verdict.passed) {
          return { ok: false, error: verdict.error, repairFeedback: verdict.repairFeedback };
        }
        return { ok: true };
      }
      case "FINALIZE": {
        if (!ctx.handle) return { ok: false, error: nonRecoverable("engine.state", "no workspace") };
        // Keep the worktree for the human review; release only the lock.
        await this.worktrees.release(ctx.handle, { removeWorktree: false });
        return { ok: true };
      }
      default:
        return { ok: false, error: nonRecoverable("engine.unknown_phase", String(ctx.phase satisfies never)) };
    }
  }

  // ── persistence helpers (journal-before-act lives in the repos) ───────────

  private lastPlanFiles = new Map<RunId, string[]>();
  private signals = new Map<RunId, AbortSignal | undefined>();

  private async enterPhase(runId: RunId, phase: RunPhaseName, attempt: number): Promise<void> {
    RunPhaseNameSchema.parse(phase);
    await this.uow.run(async (tx: TxPorts) => {
      await tx.runs.setState(runId, { status: "PHASE", phase, attempt });
      await tx.runs.enterPhase(runId, phase, attempt);
    });
  }

  private async completePhase(runId: RunId, phase: RunPhaseName, attempt: number): Promise<void> {
    await this.uow.run(async (tx) => {
      await tx.runs.completePhase(runId, phase, attempt);
    });
  }

  private async fail(runId: RunId, error: SignetError): Promise<RunOutcome> {
    await this.uow.run(async (tx) => {
      await tx.runs.setState(runId, { status: "FAILED", errorCode: error.code, errorKind: error.kind });
    });
    return { outcome: "failed", error };
  }

  private async bumpRepair(incrementId: IncrementId, attempt: number): Promise<void> {
    // Was: read the row, assign `row.repairAttempt = attempt`, then call transition().
    // That mutated a local object and wrote only the state, so the counter never moved
    // and the repair budget never ran out — an unbounded loop that spent 49 gate rounds
    // on one step before anybody noticed. The port now has an operation that actually
    // writes it.
    await this.uow.run(async (tx) => {
      await tx.increments.setBudget(incrementId, { repairAttempt: attempt });
    });
  }

  private async bumpRestart(incrementId: IncrementId): Promise<void> {
    // Same bug as bumpRepair: `row.freshRestarts += 1` on a local object went nowhere.
    await this.uow.run(async (tx) => {
      const row = await tx.increments.get(incrementId);
      if (row) await tx.increments.setBudget(incrementId, { freshRestarts: row.freshRestarts + 1 });
    });
  }

  private async incrementRow(incrementId: IncrementId) {
    return this.uow.run(async (tx) => {
      const row = await tx.increments.get(incrementId);
      if (!row) throw new Error(`increment not found: ${incrementId}`);
      return row;
    });
  }

  private async runRow(runId: RunId) {
    return this.uow.run(async (tx) => {
      const row = await tx.runs.get(runId);
      if (!row) throw new Error(`run not found: ${runId}`);
      return row;
    });
  }
}
