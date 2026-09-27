// Running automation, and refusing to.
//
// A workflow runs its recipes in order. Each recipe is a saved request, so running one
// is: propose a breakdown against its repo, create the feature, and approve the first
// signature so the work actually starts. Then it stops. It does not merge.
//
// That boundary is the whole design. Automation gets signature 1 — the one that approves
// SPENDING — and never signature 2, the one that approves CODE landing on your base
// branch. It is worth being blunt that this does cost something: for automated work
// "a feature between two human signatures" becomes one. The remaining signature is the
// one that protects the repository, which is why it is the one that stays.
//
// Three guards, written here at the start rather than added after something ran away:
//
//   1. A KILL SWITCH, separate from the dispatcher's pause. Pausing the pipeline stops
//      work from running; this stops work from being CREATED. Conflating them would make
//      "stop everything" ambiguous at the moment you most need it unambiguous.
//   2. A DEPTH LIMIT. An event-triggered workflow can cause the event it listens for —
//      react to a merge by creating work that merges — and a counter is the difference
//      between a loop that terminates and one that does not.
//   3. NO SELF-RETRIGGER. A workflow never fires on an event its own run produced, which
//      closes the tightest loop before the depth limit is even consulted.
//
// Every refusal is RECORDED, with its reason. An unattended run that silently skipped is
// indistinguishable from one that never fired, and that is the worst possible state for
// something you are trusting to act while you are not watching.

import { randomUUID } from "node:crypto";
import {
  WorkflowTriggerSchema,
  placeholdersIn,
  type WorkflowEvent,
  type WorkflowStepOutcome,
  type WorkflowTrigger,
} from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";
import type { Logger } from "../domain/runtime/logger.js";

/** What the engine needs in order to turn a recipe into started work. */
export interface WorkflowDeps {
  db: PrismaClient;
  /** Proposes a breakdown for a description against a repo. */
  propose(input: { goal: string; repoId?: string }): Promise<
    | {
        ok: true;
        title: string;
        briefMd: string;
        increments: Array<{ title: string; declaredSurface: string[]; acceptanceMd: string }>;
        /**
         * Set when the honest answer was that nothing needs doing. A maintenance recipe
         * finding nothing is the system working, not failing — treating it as an error is
         * what made the first real automated run report failure against a clean repo.
         */
        noWorkNeeded?: string | null;
      }
    | { ok: false; reason: string }
  >;
  createFeature(input: {
    title: string;
    briefMd: string;
    repoId?: string;
    increments: Array<{ title: string; declaredSurface: string[]; acceptanceMd: string }>;
  }): Promise<{ featureId: string }>;
  /** Signature 1 — starts the run. The only signature automation is given. */
  approve(incrementId: string): Promise<unknown>;
  log: Logger;
}

/** Why a firing did nothing. Recorded rather than inferred from silence. */
type Skip = { skipped: true; reason: string };

export class WorkflowEngine {
  /**
   * In memory on purpose: a restart should leave automation ARMED rather than silently
   * paused, and a persisted pause that nobody remembers setting is how a scheduled job
   * stops working for a month without anybody noticing. The switch is for right now.
   */
  private paused = false;

  /** Run ids produced by this process, so a workflow cannot react to its own output. */
  private readonly ownRuns = new Set<string>();

  constructor(private readonly deps: WorkflowDeps) {}

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.deps.log.info("automation.paused", { paused });
  }

  /** Records that a run belongs to us, so events it causes do not retrigger anything. */
  private claim(runId: string): void {
    this.ownRuns.add(runId);
    // Bounded: this only needs to cover the window in which an event could arrive.
    if (this.ownRuns.size > 500) {
      const first = this.ownRuns.values().next().value;
      if (first !== undefined) this.ownRuns.delete(first);
    }
  }

  isOurs(runId: string): boolean {
    return this.ownRuns.has(runId);
  }

  /**
   * Runs one workflow. Returns the run id, or a skip with its reason — a caller should
   * never have to guess why nothing happened.
   */
  async run(
    workflowId: string,
    opts: { triggeredBy: "schedule" | "event" | "manual"; cause?: unknown; depth?: number },
  ): Promise<{ runId: string } | Skip> {
    const depth = opts.depth ?? 0;

    if (this.paused && opts.triggeredBy !== "manual") {
      // Manual still works while paused: the switch is for unattended firing, and a
      // human pressing a button is not what anybody is protecting themselves from.
      return { skipped: true, reason: "Automation is paused." };
    }

    const wf = await this.deps.db.workflow.findUnique({
      where: { id: workflowId },
      include: { steps: { orderBy: { orderIndex: "asc" }, include: { recipe: true } } },
    });
    if (!wf) return { skipped: true, reason: "That workflow no longer exists." };

    if (!wf.enabled && opts.triggeredBy !== "manual") {
      return { skipped: true, reason: "That workflow is switched off." };
    }

    if (depth > wf.maxDepth) {
      // The loop-breaker. Recorded loudly: hitting this means an automation is feeding
      // itself, which is a design problem the user needs to see rather than a transient.
      this.deps.log.warn("automation.depth_exceeded", { workflowId, depth, maxDepth: wf.maxDepth });
      return {
        skipped: true,
        reason: `Stopped: this run was ${depth} links deep in a chain and the limit is ${wf.maxDepth}. Something is triggering itself.`,
      };
    }

    const unfilled = wf.steps.flatMap((s) => placeholdersIn(s.recipe.goalMd));
    if (unfilled.length > 0) {
      // A template inside a workflow can never be filled in, because there is nobody
      // there to fill it. Refusing beats substituting something plausible.
      return {
        skipped: true,
        reason: `Cannot run unattended: ${wf.steps.find((s) => placeholdersIn(s.recipe.goalMd).length > 0)?.recipe.name} still has blanks (${[...new Set(unfilled)].join(", ")}). Only recipes with nothing left to fill in can be automated.`,
      };
    }

    const runId = randomUUID();
    await this.deps.db.workflowRun.create({
      data: {
        id: runId,
        workflowId,
        triggeredBy: opts.triggeredBy,
        causeJson: opts.cause === undefined ? null : JSON.stringify(opts.cause),
        depth,
        status: "running",
      },
    });

    const outcomes: WorkflowStepOutcome[] = [];
    let failed = false;

    for (const step of wf.steps) {
      const recipe = step.recipe;
      const repoId = recipe.repoOrigin === "github" ? `github:${recipe.repoLabel}` : (recipe.repoPath ?? undefined);

      try {
        const proposal = await this.deps.propose({
          goal: recipe.goalMd,
          ...(repoId ? { repoId } : {}),
        });
        if (!proposal.ok) {
          outcomes.push({ recipeName: recipe.name, featureId: null, stepsQueued: 0, error: proposal.reason, nothingNeeded: null });
          failed = true;
          // Stop the workflow: later recipes usually assume the earlier ones landed, and
          // carrying on would build on something that is not there.
          break;
        }

        if (proposal.increments.length === 0) {
          // Nothing to do, and that is a result. No feature is created, because a feature
          // with no steps is not a thing — but the run succeeds and says why, so a nightly
          // automation that correctly finds nothing does not read as broken.
          outcomes.push({
            recipeName: recipe.name,
            featureId: null,
            stepsQueued: 0,
            error: null,
            nothingNeeded: proposal.noWorkNeeded ?? "Nothing needed doing.",
          });
          continue;
        }

        const created = await this.deps.createFeature({
          title: proposal.title,
          briefMd: proposal.briefMd,
          ...(repoId ? { repoId } : {}),
          increments: proposal.increments,
        });

        // Signature 1, automatically — the only one automation gets. Only the FIRST
        // step is started: the rest of a feature's steps stay queued, so an unattended
        // run cannot quietly consume a whole quota window.
        const increments = await this.deps.db.increment.findMany({
          where: { featureId: created.featureId },
          orderBy: { orderIndex: "asc" },
          select: { id: true },
        });
        const first = increments[0];
        if (first) await this.deps.approve(first.id);

        outcomes.push({
          recipeName: recipe.name,
          featureId: created.featureId,
          stepsQueued: increments.length,
          error: null,
          nothingNeeded: null,
        });
      } catch (e) {
        outcomes.push({
          recipeName: recipe.name,
          featureId: null,
          stepsQueued: 0,
          error: e instanceof Error ? e.message : String(e),
          nothingNeeded: null,
        });
        failed = true;
        break;
      }
    }

    this.claim(runId);
    await this.deps.db.workflowRun.update({
      where: { id: runId },
      data: {
        status: failed ? "failed" : "succeeded",
        outcomeJson: JSON.stringify({ outcomes }),
        finishedAt: new Date(),
      },
    });

    return { runId };
  }

  /** Records a skip, so the reason survives past this function call. */
  async recordSkip(
    workflowId: string,
    triggeredBy: "schedule" | "event" | "manual",
    reason: string,
    depth = 0,
  ): Promise<void> {
    await this.deps.db.workflowRun.create({
      data: {
        id: randomUUID(),
        workflowId,
        triggeredBy,
        depth,
        status: "skipped",
        outcomeJson: JSON.stringify({ outcomes: [], skipReason: reason }),
        finishedAt: new Date(),
      },
    });
  }

  /**
   * Fires every enabled workflow listening for an event.
   *
   * `causedByRunId` is how self-retrigger is prevented: an event produced by our own run
   * is ignored outright, which closes the tightest loop before the depth counter is even
   * looked at.
   */
  async onEvent(event: WorkflowEvent, cause: { runId?: string; depth?: number } = {}): Promise<void> {
    if (this.paused) return;
    if (cause.runId && this.isOurs(cause.runId)) {
      this.deps.log.info("automation.ignored_own_event", { event, runId: cause.runId });
      return;
    }

    const candidates = await this.deps.db.workflow.findMany({ where: { enabled: true } });
    for (const wf of candidates) {
      const trigger = this.parseTrigger(wf.triggerJson, wf.id);
      if (trigger?.kind !== "event" || trigger.event !== event) continue;
      const result = await this.run(wf.id, {
        triggeredBy: "event",
        cause: { event, ...cause },
        depth: (cause.depth ?? 0) + 1,
      });
      if ("skipped" in result) await this.recordSkip(wf.id, "event", result.reason, (cause.depth ?? 0) + 1);
    }
  }

  /**
   * A trigger that will not parse disables the workflow rather than crashing the tick.
   * One corrupt row must not stop every other automation from running.
   */
  private parseTrigger(json: string, workflowId: string): WorkflowTrigger | null {
    try {
      return WorkflowTriggerSchema.parse(JSON.parse(json)); // signet-policy-allow: raw-json-parse -- validated on the next line by the schema
    } catch (e) {
      this.deps.log.warn("automation.bad_trigger", { workflowId, error: String(e) });
      return null;
    }
  }

  /**
   * Fires schedules that are due. Called on a timer.
   *
   * Deliberately does NOT catch up. A process that was down for two days must not wake
   * and fire forty-eight hourly runs — the point of a schedule is "roughly now", and a
   * burst of backdated work is never what was wanted. Due means "the window has passed
   * and we have not fired since it opened".
   */
  async tick(now: Date): Promise<void> {
    if (this.paused) return;
    const workflows = await this.deps.db.workflow.findMany({ where: { enabled: true } });

    for (const wf of workflows) {
      const trigger = this.parseTrigger(wf.triggerJson, wf.id);
      if (trigger?.kind !== "schedule") continue;
      if (!isDue(trigger, wf.lastFiredAt, now)) continue;

      // Stamped BEFORE running: if the run throws, the schedule must not immediately
      // retry on the next tick and hammer the same failure every few seconds.
      await this.deps.db.workflow.update({ where: { id: wf.id }, data: { lastFiredAt: now } });
      const result = await this.run(wf.id, { triggeredBy: "schedule", depth: 0 });
      if ("skipped" in result) await this.recordSkip(wf.id, "schedule", result.reason);
    }
  }
}

/**
 * Whether a schedule's window has opened since it last fired.
 *
 * Exported for the spec: this is pure arithmetic and the easiest thing here to get
 * subtly wrong, so it is tested directly rather than through the engine.
 */
export function isDue(trigger: ScheduleLike, lastFiredAt: Date | null, now: Date): boolean {
  const windowStart = currentWindowStart(trigger, now);
  if (windowStart === null) return false;
  // Never fired: fire once we are inside a window, not immediately on creation.
  if (!lastFiredAt) return now >= windowStart;
  return lastFiredAt < windowStart;
}

export interface ScheduleLike {
  every: "hour" | "day" | "week";
  atHour: number;
  atMinute: number;
  onWeekday: number;
}

/** The start of the window `now` falls in, or null when `now` is before today's. */
function currentWindowStart(trigger: ScheduleLike, now: Date): Date | null {
  const d = new Date(now);
  if (trigger.every === "hour") {
    d.setMinutes(trigger.atMinute, 0, 0);
    return d <= now ? d : new Date(d.getTime() - 60 * 60 * 1000);
  }
  d.setHours(trigger.atHour, trigger.atMinute, 0, 0);
  if (trigger.every === "day") {
    return d <= now ? d : new Date(d.getTime() - 24 * 60 * 60 * 1000);
  }
  // Weekly: walk back to the most recent occurrence of the chosen weekday.
  const back = (d.getDay() - trigger.onWeekday + 7) % 7;
  d.setDate(d.getDate() - back);
  if (d > now) d.setDate(d.getDate() - 7);
  return d;
}
