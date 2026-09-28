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
  type FenceQuestion,
  type IncrementId,
  type IncrementPlan,
  type ModelUsage,
  type RunId,
  type RunPhaseName,
  type SessionRef,
  type SignetError,
} from "@signet/contracts";
import { afterPhaseComplete, afterPhaseFailure, type RunDecision } from "../domain/runtime/run-machine.js";
import { parseAgentQuestion } from "../domain/adapter/agent-question.js";
import type { Logger } from "../domain/runtime/logger.js";
import type { TxPorts, UnitOfWork } from "../domain/runtime/ports.js";
import type { WorktreeHandle, WorktreeManager } from "../domain/runtime/worktree-manager.js";

/** What the engine needs from the Claude Code adapter (implemented in domain/adapter). */
export interface AgentDriver {
  plan(input: {
    packDir: string;
    workspacePath: string;
    signal?: AbortSignal;
    /** Optional: the planning agent reads the repo, and what it reads is worth showing. */
    onEvent?: (ev: AdapterEvent) => Promise<void>;
  }): Promise<
    { ok: true; plan: unknown; sessionRef: SessionRef; usage: ModelUsage[] } | { ok: false; error: SignetError }
  >;
  implement(input: {
    packDir: string;
    workspacePath: string;
    resumeSession: SessionRef | null;
    repairFeedback: string | null;
    signal?: AbortSignal;
    onEvent: (ev: AdapterEvent) => Promise<void>;
  }): Promise<
    // resultText carries the agent's closing message, where it states which test proves
    // which promise. Optional so a driver that cannot supply it still type-checks.
    { ok: true; sessionRef: SessionRef; resultText?: string } | { ok: false; error: SignetError }
  >;
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
  | { outcome: "escalated"; question: string; fence?: FenceQuestion; options?: string[]; why?: string };

/**
 * Where the agent's work goes besides the database. Both optional, so every existing
 * construction of the engine keeps working.
 */
export interface RunEngineHooks {
  /** Every adapter event from planning and implementing, for "watch it work". */
  onAgentEvent?: (input: {
    runId: RunId;
    incrementId: IncrementId;
    phase: "plan" | "implement";
    workspacePath: string;
    event: AdapterEvent;
  }) => Promise<void>;
  /** The agent's closing message after implementing, for the promises check. */
  onImplementResult?: (input: { runId: RunId; packDir: string; resultText: string }) => Promise<void>;
}

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

  /** Set after construction, like the other optional wiring in this codebase. */
  hooks: RunEngineHooks = {};

  /** Hooks must never change a run's outcome: watching is not allowed to break the work. */
  private async tellHook(fn: () => Promise<void> | undefined): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log.warn("engine.hook_failed", { error: String(e) });
    }
  }

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

      // A phase can end the run with a question directly — the fence check does, because
      // "may I change this other file" is a decision for a person, not a failure to repair.
      if (!result.ok && result.escalate) {
        await this.completePhase(runId, phase, phaseAttempt);
        await this.markStoppedToAsk(runId);
        await this.releaseLock(handle);
        log.warn("run.escalated", { phase });
        return {
          outcome: "escalated",
          question: result.escalate.question,
          ...(result.escalate.fence ? { fence: result.escalate.fence } : {}),
          ...(result.escalate.options ? { options: result.escalate.options } : {}),
          ...(result.escalate.why ? { why: result.escalate.why } : {}),
        };
      }

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
          // The lock, not the worktree. Only FINALIZE released it before, so every
          // non-success ending left a lock file behind holding a pid that had exited —
          // five of them had accumulated on the pilot machine. The stale-pid check in
          // acquire() meant nothing was actually blocked, which is precisely why it went
          // unnoticed: litter that never breaks anything is litter nobody looks at.
          //
          // The worktree STAYS. A parked run resumes into it, and an escalated or failed
          // one is the only place the evidence lives.
          await this.releaseLock(handle);
          return { outcome: "parked", resumeAt: decision.resumeAt };
        case "escalate":
          log.warn("run.escalated", {});
          await this.markStoppedToAsk(runId);
          await this.releaseLock(handle);
          return { outcome: "escalated", question: decision.question };
        case "fail":
          await this.releaseLock(handle);
          return this.fail(runId, decision.error);
        default:
          return this.fail(runId, nonRecoverable("engine.unknown_decision", "unreachable"));
      }
    }
  }

  /**
   * Releases the execution lock while keeping the worktree.
   *
   * Errors are swallowed: this runs on the way out of a run that is already ending, and
   * a failure to tidy up must not change the outcome that is being reported. A leaked
   * lock is recoverable — acquire() replaces one held by a dead pid — whereas a run that
   * reports "failed" because its cleanup threw is a lie about what happened.
   */
  /**
   * Ends the RUN, not the step, when it stops to ask.
   *
   * It was left in its last phase, which had two consequences: the console reported a run
   * that had stopped as still running, and the boot-time completer — which re-queues every
   * run found mid-phase — would restart a run that was waiting on a person. Answering the
   * question starts a new run anyway, so this one is finished.
   */
  private async markStoppedToAsk(runId: RunId): Promise<void> {
    await this.uow.run(async (tx) => {
      await tx.runs.setState(runId, { status: "ABORTED", reason: "stopped to ask a question" });
    });
  }

  private async releaseLock(handle: WorktreeHandle | null): Promise<void> {
    if (!handle) return;
    await this.worktrees.release(handle, { removeWorktree: false }).catch(() => {});
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
    | { ok: true }
    | {
        ok: false;
        error: SignetError;
        repairFeedback?: string;
        quotaResetsAt?: Date | null;
        escalate?: { question: string; fence?: FenceQuestion; options?: string[]; why?: string };
      }
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
        const planWorkspace = ctx.handle.path;
        const res = await this.agent.plan({
          packDir: ctx.packDir,
          workspacePath: planWorkspace,
          ...(planSignal ? { signal: planSignal } : {}),
          onEvent: async (event) => {
            await this.tellHook(() =>
              this.hooks.onAgentEvent?.({
                runId: ctx.runId,
                incrementId: ctx.incrementId,
                phase: "plan",
                workspacePath: planWorkspace,
                event,
              }),
            );
          },
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
        // Stash the plan in memory for SCOPE_CHECK's declaredSurface comparison.
        this.lastPlans.set(ctx.runId, parsed.data);
        return { ok: true };
      }
      case "SCOPE_CHECK": {
        const plan = this.lastPlans.get(ctx.runId);
        const planFiles = plan?.filesToTouch ?? [];
        const verdict = this.scope.check(planFiles, ctx.declaredSurface);
        if (!verdict.inScope) {
          // A question, not a death. This used to be non-recoverable: the run was killed
          // and everything it had worked out was thrown away, when the honest situation is
          // that the agent found a real reason to touch another file and a person should
          // decide whether it may. The fence is still absolute — nothing outside it is
          // changed without that person saying so.
          const reasons = plan?.outsideReasons ?? {};
          const given = verdict.outside.map((f) => reasons[f]).filter((r): r is string => Boolean(r));
          const reason = given.length > 0 ? given.join(" ") : null;
          return {
            ok: false,
            error: nonRecoverable(
              "scope.outside_surface",
              `plan touches files outside the declared surface: ${verdict.outside.join(", ")}`,
            ),
            escalate: {
              question:
                `It wants to change ${verdict.outside.join(", ")}, outside what this step may change.` +
                (reason ? ` Its reason: ${reason}` : " It did not say why."),
              fence: { outside: verdict.outside, reason, surface: ctx.declaredSurface },
            },
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
            const workspacePath = ctx.handle?.path ?? "";
            await this.tellHook(() =>
              this.hooks.onAgentEvent?.({
                runId: ctx.runId,
                incrementId: ctx.incrementId,
                phase: "implement",
                workspacePath,
                event: ev,
              }),
            );
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
        if (res.resultText) {
          const packDir = ctx.packDir;
          const resultText = res.resultText;
          await this.tellHook(() => this.hooks.onImplementResult?.({ runId: ctx.runId, packDir, resultText }));
        }
        await this.worktrees.commitAll(ctx.handle, `signet: increment ${ctx.incrementId} implement`);
        // The agent stopped to ask. What it wrote so far is kept, committed, in the
        // workspace; the person's answer becomes part of the request and it carries on.
        const asked = res.resultText ? parseAgentQuestion(res.resultText) : null;
        if (asked) {
          return {
            ok: false,
            error: recoverable("agent.asked", asked.question),
            escalate: { question: asked.question, options: asked.options, ...(asked.why ? { why: asked.why } : {}) },
          };
        }
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

  private lastPlans = new Map<RunId, IncrementPlan>();
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
