// Reading and writing recipes and workflows.
//
// Plain CRUD, kept out of the engine so the engine stays about the one thing that is
// genuinely hard: deciding whether an unattended run is allowed to happen.
//
// The one piece of judgement here: `placeholders` is DERIVED from the description rather
// than stored. A recipe with no blanks can be run with one click and can be automated; a
// recipe with blanks can be neither. Storing that as a flag would let it drift out of
// step with the text it describes the moment somebody edits the description.

import { randomUUID } from "node:crypto";
import {
  WorkflowTriggerSchema,
  placeholdersIn,
  type AutomationState,
  type CreateRecipeRequest,
  type Recipe,
  type RoutineFiring,
  type RoutineStop,
  type SaveWorkflowRequest,
  type Workflow,
  type WorkflowRunView,
  type WorkflowStepOutcome,
} from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";

export interface AutomationStoreDeps {
  db: PrismaClient;
  /** Turns what the picker sent into a repo to record, same as feature creation. */
  resolveRepo(repoId: string | undefined): { path: string; label: string; origin: string };
  isPaused(): boolean;
}

export class AutomationStore {
  constructor(private readonly deps: AutomationStoreDeps) {}

  async listRecipes(): Promise<Recipe[]> {
    const rows = await this.deps.db.recipe.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      goalMd: r.goalMd,
      repoPath: r.repoPath,
      repoOrigin: r.repoOrigin === "github" ? ("github" as const) : ("local" as const),
      repoLabel: r.repoLabel,
      // Derived, never stored — see the note at the top of this file.
      placeholders: placeholdersIn(r.goalMd),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createRecipe(req: CreateRecipeRequest): Promise<{ id: string }> {
    const repo = this.deps.resolveRepo(req.repoId);
    const id = randomUUID();
    await this.deps.db.recipe.create({
      data: {
        id,
        name: req.name,
        goalMd: req.goalMd,
        repoPath: repo.path || null,
        repoOrigin: repo.origin,
        repoLabel: repo.label,
      },
    });
    return { id };
  }

  async deleteRecipe(id: string): Promise<void> {
    // Refuse rather than cascade: silently emptying a workflow because a recipe was
    // deleted turns it into a scheduled no-op, which is the kind of automation that
    // looks armed and does nothing.
    const used = await this.deps.db.workflowStep.count({ where: { recipeId: id } });
    if (used > 0) {
      throw Object.assign(new Error(`this recipe is used by ${used} workflow step(s)`), {
        signet: {
          kind: "conflict" as const,
          code: "recipe.in_use",
          message: `This recipe is used by ${used} workflow step${used === 1 ? "" : "s"}. Remove it from those workflows first.`,
        },
      });
    }
    await this.deps.db.recipe.delete({ where: { id } });
  }

  async listWorkflows(): Promise<Workflow[]> {
    const rows = await this.deps.db.workflow.findMany({
      orderBy: { createdAt: "desc" },
      include: { steps: { orderBy: { orderIndex: "asc" }, include: { recipe: true } } },
    });
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      enabled: w.enabled,
      // A trigger that will not parse is reported as manual rather than throwing: one
      // corrupt row must not make the whole screen fail to load.
      trigger: safeTrigger(w.triggerJson),
      maxDepth: w.maxDepth,
      steps: w.steps.map((s) => ({
        id: s.id,
        recipeId: s.recipeId,
        recipeName: s.recipe.name,
        orderIndex: s.orderIndex,
      })),
      lastFiredAt: w.lastFiredAt?.toISOString() ?? null,
      createdAt: w.createdAt.toISOString(),
    }));
  }

  async saveWorkflow(req: SaveWorkflowRequest): Promise<{ id: string }> {
    const id = req.id ?? randomUUID();
    await this.deps.db.$transaction(async (tx) => {
      const data = {
        name: req.name,
        enabled: req.enabled,
        maxDepth: req.maxDepth,
        triggerJson: JSON.stringify(WorkflowTriggerSchema.parse(req.trigger)),
      };
      if (req.id) {
        // Changing a slot in the sentence edits the routine in place: its history stays.
        await tx.workflow.update({ where: { id }, data });
        await tx.workflowStep.deleteMany({ where: { workflowId: id } });
      } else {
        await tx.workflow.create({ data: { id, ...data } });
      }
      let order = 0;
      for (const recipeId of req.recipeIds) {
        await tx.workflowStep.create({ data: { id: randomUUID(), workflowId: id, recipeId, orderIndex: order++ } });
      }
    });
    return { id };
  }

  async setWorkflowEnabled(id: string, enabled: boolean): Promise<void> {
    await this.deps.db.workflow.update({ where: { id }, data: { enabled } });
  }

  async deleteWorkflow(id: string): Promise<void> {
    await this.deps.db.workflow.delete({ where: { id } });
  }

  /** Recent firings across all workflows, newest first. */
  async listRuns(limit = 50): Promise<WorkflowRunView[]> {
    const rows = await this.deps.db.workflowRun.findMany({
      orderBy: { startedAt: "desc" },
      take: limit,
      include: { workflow: { select: { name: true } } },
    });
    return rows.map((r) => {
      const parsed = safeOutcome(r.outcomeJson);
      return {
        id: r.id,
        workflowId: r.workflowId,
        workflowName: r.workflow.name,
        triggeredBy: r.triggeredBy === "schedule" || r.triggeredBy === "event" ? r.triggeredBy : ("manual" as const),
        depth: r.depth,
        status:
          r.status === "running" || r.status === "succeeded" || r.status === "failed" || r.status === "skipped"
            ? r.status
            : ("failed" as const),
        skipReason: parsed.skipReason,
        outcomes: parsed.outcomes,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * One routine's recent firings, newest first, with what each recipe did, what the work
   * it started has cost, and where that work stands now: the canvas draws these over its
   * cards.
   */
  async firings(workflowId: string, limit = 7): Promise<RoutineFiring[]> {
    const { db } = this.deps;
    const rows = await db.workflowRun.findMany({ where: { workflowId }, orderBy: { startedAt: "desc" }, take: limit });
    const featureIds = [...new Set(rows.flatMap((r) => safeOutcome(r.outcomeJson).outcomes.map((o) => o.featureId)).filter((f): f is string => !!f))];
    const features = await db.feature.findMany({
      where: { id: { in: featureIds } },
      include: { increments: { orderBy: { orderIndex: "asc" }, select: { id: true, status: true, stateJson: true } } },
    });
    const spend = await db.usageLedgerEntry.groupBy({
      by: ["runId"],
      where: { run: { increment: { featureId: { in: featureIds } } } },
      _sum: { costUsd: true },
    });
    const runsOf = await db.run.findMany({ where: { increment: { featureId: { in: featureIds } } }, select: { id: true, increment: { select: { featureId: true } } } });
    const costOf = (featureId: string): number | null => {
      const ids = new Set(runsOf.filter((r) => r.increment.featureId === featureId).map((r) => r.id));
      const sum = spend.filter((s) => ids.has(s.runId)).reduce((n, s) => n + Number(s._sum.costUsd ?? 0), 0);
      return ids.size === 0 ? null : Math.round(sum * 100) / 100;
    };
    return rows.map((r) => {
      const parsed = safeOutcome(r.outcomeJson);
      const steps = parsed.outcomes.map((o) => {
        const f = o.featureId ? features.find((x) => x.id === o.featureId) : undefined;
        const first = f?.increments[0];
        const dismissed = first?.status === "FAILED" && first.stateJson.includes('"dismissedAt"');
        return {
          stepId: o.stepId ?? null,
          recipeName: o.recipeName,
          featureId: o.featureId,
          featureTitle: f?.title ?? null,
          incrementId: first?.id ?? null,
          now: first ? (NOW_WORDS[first.status] ?? first.status.toLowerCase()) : null,
          yours: !!first && YOURS.has(first.status) && !dismissed,
          costUsd: o.featureId ? costOf(o.featureId) : null,
          nothingNeeded: o.nothingNeeded ?? null,
          error: o.error,
        };
      });
      const costs = steps.map((s) => s.costUsd).filter((c): c is number => c !== null);
      return {
        id: r.id,
        triggeredBy: r.triggeredBy === "schedule" || r.triggeredBy === "event" ? r.triggeredBy : ("manual" as const),
        status: r.status === "running" || r.status === "succeeded" || r.status === "failed" || r.status === "skipped" ? r.status : ("failed" as const),
        skipReason: parsed.skipReason,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        costUsd: costs.length === 0 ? null : Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100,
        steps,
      };
    });
  }

  /** Routines that stopped and still need a person. */
  async stops(): Promise<RoutineStop[]> {
    return readRoutineStops(this.deps.db);
  }

  /** Takes a stopped routine off the Desk. The firing and its reason stay in the history. */
  async dismissStop(runId: string): Promise<void> {
    const row = await this.deps.db.workflowRun.findUniqueOrThrow({ where: { id: runId } });
    let record: Record<string, unknown> = {};
    try {
      record = JSON.parse(row.outcomeJson ?? "{}") as Record<string, unknown>; // signet-policy-allow: raw-json-parse -- our own record, extended with one field
    } catch {
      record = {};
    }
    await this.deps.db.workflowRun.update({
      where: { id: runId },
      data: { outcomeJson: JSON.stringify({ ...record, dismissedAt: new Date().toISOString() }) },
    });
  }

  async state(): Promise<AutomationState> {
    const [recipes, total, enabled] = await Promise.all([
      this.deps.db.recipe.count(),
      this.deps.db.workflow.count(),
      this.deps.db.workflow.count({ where: { enabled: true } }),
    ]);
    return { paused: this.deps.isPaused(), recipes, workflowsTotal: total, workflowsEnabled: enabled };
  }
}

/** A trigger we cannot read becomes manual, so a bad row cannot fire on its own. */
function safeTrigger(json: string): Workflow["trigger"] {
  try {
    return WorkflowTriggerSchema.parse(JSON.parse(json)); // signet-policy-allow: raw-json-parse -- validated by the schema on the same line
  } catch {
    return { kind: "manual" };
  }
}

/**
 * Routines that stopped because a recipe could not start, not yet dismissed. A stop
 * needs a person, so it belongs on the Desk rather than only in the history.
 */
export async function readRoutineStops(db: PrismaClient): Promise<RoutineStop[]> {
  const rows = await db.workflowRun.findMany({
    where: { status: "failed", NOT: { outcomeJson: { contains: '"dismissedAt"' } } },
    include: { workflow: { select: { name: true } } },
    orderBy: { startedAt: "asc" },
    take: 20,
  });
  return rows.flatMap((r) => {
    const failed = safeOutcome(r.outcomeJson).outcomes.find((o) => o.error);
    if (!failed) return [];
    return [{
      runId: r.id,
      workflowId: r.workflowId,
      routineName: r.workflow.name,
      recipeName: failed.recipeName,
      reason: failed.error ?? "It could not start.",
      at: (r.finishedAt ?? r.startedAt).toISOString(),
    }];
  });
}

/** Where a step's work stands, in the words the console uses. */
const NOW_WORDS: Record<string, string> = {
  MERGED: "sealed",
  AWAITING_SIGNATURE: "at your seal",
  CONTEXT_READY: "waiting for your initials",
  RUNNING: "building",
  VERIFYING: "checking",
  ESCALATED: "asked you a question",
  PARKED: "waiting for your Claude quota",
  FAILED: "failed",
  PLANNED: "not started",
};
const YOURS = new Set(["AWAITING_SIGNATURE", "CONTEXT_READY", "ESCALATED", "FAILED"]);

function safeOutcome(json: string | null): { outcomes: WorkflowStepOutcome[]; skipReason: string | null } {
  if (!json) return { outcomes: [], skipReason: null };
  try {
    const parsed = JSON.parse(json) as { outcomes?: WorkflowStepOutcome[]; skipReason?: string }; // signet-policy-allow: raw-json-parse -- narrow shape we wrote ourselves
    return { outcomes: parsed.outcomes ?? [], skipReason: parsed.skipReason ?? null };
  } catch {
    return { outcomes: [], skipReason: null };
  }
}
