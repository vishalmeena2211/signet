// Typed console client — response shapes are the contracts schemas, parsed on
// arrival (parse, don't assume, on the client too).
//
// Every failure carries the server's own explanation. A console whose buttons
// fail silently is a console you cannot control, so the message the API gives
// us is the message the user sees.

import { z } from "zod";
import {
  ActivityViewSchema,
  BriefVersionViewSchema,
  DesignOfRecordSchema,
  EscalationViewSchema,
  FeatureSummarySchema,
  GateVerdictViewSchema,
  IncrementDetailSchema,
  IncrementDiffViewSchema,
  QuotaStateViewSchema,
  RuleCardSchema,
  ActivityEventSchema,
  DispatcherStateSchema,
  OverviewSchema,
  PackViewSchema,
  RunDetailSchema,
  RunSummarySchema,
  SystemInfoSchema,
  ContextGraphSchema,
  GithubRepoListSchema,
  type ActivityEvent,
  type DispatcherControlRequest,
  type DispatcherState,
  type Overview,
  type PackView,
  type RunDetail,
  type RunSummary,
  type SystemInfo,
  type ContextGraph,
  type GithubRepoList,
  type ActivityView,
  type BriefVersionView,
  type ApproveDesignRequest,
  type CreateFeatureRequest,
  type DesignOfRecord,
  type EscalationView,
  type FeatureSummary,
  type GateVerdictView,
  type IncrementDetail,
  type IncrementDiffView,
  type QuotaStateView,
  type RuleCard,
  FeatureProposalResponseSchema,
  RepoOptionsResponseSchema,
  AutomationStateSchema,
  RecipeSchema,
  WorkflowSchema,
  WorkflowRunViewSchema,
  type ProposeFeatureRequest,
  type FeatureProposalResponse,
  type RepoOptionsResponse,
  type AutomationState,
  type Recipe,
  type CreateRecipeRequest,
  type Workflow,
  type SaveWorkflowRequest,
  type WorkflowRunView,
} from "@signet/contracts";

/** An API failure with the server's reason attached, ready to render. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Nest sends {statusCode, message, error}; message may be a string or an array. */
const ProblemSchema = z.object({
  message: z.union([z.string(), z.array(z.string())]).optional(),
  error: z.string().optional(),
});

async function explain(res: Response): Promise<ApiError> {
  let detail = res.statusText || `HTTP ${res.status}`;
  try {
    const parsed = ProblemSchema.safeParse(await res.json());
    if (parsed.success) {
      const m = parsed.data.message;
      detail = Array.isArray(m) ? m.join("; ") : (m ?? parsed.data.error ?? detail);
    }
  } catch {
    // A non-JSON body tells us nothing useful; the status line stands.
  }
  return new ApiError(res.status, detail);
}

async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw await explain(res);
  return schema.parse(await res.json());
}

async function send<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw await explain(res);
  return schema.parse(await res.json().catch(() => ({})));
}

const Ack = z.looseObject({});

export const api = {
  health: () =>
    get("/api/health", z.object({ ok: z.boolean(), quota: QuotaStateViewSchema })) as Promise<{
      ok: boolean;
      quota: QuotaStateView;
    }>,

  features: (): Promise<FeatureSummary[]> => get("/api/features", z.array(FeatureSummarySchema)),

  feature: (id: string) =>
    get(
      `/api/features/${id}`,
      z.object({
        feature: FeatureSummarySchema,
        increments: z.array(IncrementDetailSchema),
        briefs: z.array(BriefVersionViewSchema),
        verdicts: z.record(z.string(), z.array(GateVerdictViewSchema)),
        activity: z.record(z.string(), ActivityViewSchema),
        escalations: z.array(EscalationViewSchema),
      }),
    ) as Promise<{
      feature: FeatureSummary;
      increments: IncrementDetail[];
      briefs: BriefVersionView[];
      verdicts: Record<string, GateVerdictView[]>;
      activity: Record<string, ActivityView>;
      escalations: EscalationView[];
    }>,

  // ── automation ──
  automationState: (): Promise<AutomationState> => get("/api/automation", AutomationStateSchema),
  setAutomationPaused: (paused: boolean): Promise<AutomationState> =>
    send("/api/automation", { paused }, AutomationStateSchema),

  recipes: (): Promise<Recipe[]> => get("/api/recipes", z.array(RecipeSchema)),
  createRecipe: (req: CreateRecipeRequest): Promise<{ id: string }> =>
    send("/api/recipes", req, z.object({ id: z.string() })),
  deleteRecipe: async (id: string): Promise<void> => {
    const res = await fetch(`/api/recipes/${id}`, { method: "DELETE" });
    if (!res.ok) throw await explain(res);
  },

  workflows: (): Promise<Workflow[]> => get("/api/workflows", z.array(WorkflowSchema)),
  saveWorkflow: (req: SaveWorkflowRequest): Promise<{ id: string }> =>
    send("/api/workflows", req, z.object({ id: z.string() })),
  setWorkflowEnabled: (id: string, enabled: boolean): Promise<void> =>
    send(`/api/workflows/${id}/enabled`, { enabled }, Ack).then(() => undefined),
  deleteWorkflow: async (id: string): Promise<void> => {
    const res = await fetch(`/api/workflows/${id}`, { method: "DELETE" });
    if (!res.ok) throw await explain(res);
  },
  /** Returns the reason when nothing happened, rather than a silent success. */
  runWorkflow: (id: string): Promise<{ started: boolean; reason?: string | undefined; runId?: string | undefined }> =>
    send(
      `/api/workflows/${id}/run`,
      undefined,
      z.object({ started: z.boolean(), reason: z.string().optional(), runId: z.string().optional() }),
    ),
  workflowRuns: (): Promise<WorkflowRunView[]> => get("/api/workflow-runs", z.array(WorkflowRunViewSchema)),

  /** Every repo work can be sent to: local ones found on this machine, plus github. */
  repoOptions: (): Promise<RepoOptionsResponse> => get("/api/repos", RepoOptionsResponseSchema),

  /**
   * Asks for a breakdown. Persists nothing — the user reviews what comes back and
   * creates the feature from it, so a bad proposal costs one model call and no rows.
   */
  propose: (body: ProposeFeatureRequest): Promise<FeatureProposalResponse> =>
    send("/api/propose", body, FeatureProposalResponseSchema),

  createFeature: (req: CreateFeatureRequest): Promise<{ featureId: string }> =>
    send("/api/features", req, z.object({ featureId: z.string() })),

  answerEscalation: async (id: string, answer: string): Promise<void> => {
    await send(`/api/escalations/${id}/answer`, { answer }, Ack);
  },

  approve: act("approve"),
  merge: act("merge"),
  retry: act("retry"),
  abort: act("abort"),

  diff: (incrementId: string): Promise<IncrementDiffView> =>
    get(`/api/increments/${incrementId}/diff`, IncrementDiffViewSchema),

  /** null rather than throwing: most increments have no design, and that is not an error. */
  design: async (incrementId: string): Promise<DesignOfRecord | null> => {
    const res = await fetch(`/api/increments/${incrementId}/design`);
    if (res.status === 404) return null;
    if (!res.ok) throw await explain(res);
    return DesignOfRecordSchema.parse(await res.json());
  },

  approveDesign: async (incrementId: string, req: ApproveDesignRequest): Promise<void> => {
    await send(`/api/increments/${incrementId}/design`, req, Ack);
  },

  // ── operator visibility ──

  overview: (): Promise<Overview> => get("/api/overview", OverviewSchema),

  runs: (opts: { outcome?: string; incrementId?: string; limit?: number } = {}): Promise<RunSummary[]> => {
    const p = new URLSearchParams();
    if (opts.outcome && opts.outcome !== "all") p.set("outcome", opts.outcome);
    if (opts.incrementId) p.set("incrementId", opts.incrementId);
    p.set("limit", String(opts.limit ?? 100));
    return get(`/api/runs?${p.toString()}`, z.array(RunSummarySchema));
  },

  run: (id: string): Promise<RunDetail> => get(`/api/runs/${id}`, RunDetailSchema),

  /** null rather than throwing: an increment that never ran has no pack, and that is normal. */
  pack: async (incrementId: string): Promise<PackView | null> => {
    const res = await fetch(`/api/increments/${incrementId}/pack`);
    if (res.status === 404) return null;
    if (!res.ok) throw await explain(res);
    return PackViewSchema.parse(await res.json());
  },

  activityFeed: (limit = 100): Promise<ActivityEvent[]> =>
    get(`/api/activity?limit=${limit}`, z.array(ActivityEventSchema)),

  system: (): Promise<SystemInfo> => get("/api/system", SystemInfoSchema),

  githubRepos: (): Promise<GithubRepoList> => get("/api/github/repos", GithubRepoListSchema),

  graph: (repo?: string): Promise<ContextGraph> =>
    get(`/api/graph${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, ContextGraphSchema),

  dispatcher: (): Promise<DispatcherState> => get("/api/dispatcher", DispatcherStateSchema),

  setDispatcher: (req: DispatcherControlRequest): Promise<DispatcherState> =>
    send("/api/dispatcher", req, DispatcherStateSchema),

  ruleQueue: (repo?: string): Promise<RuleCard[]> =>
    get(
      `/api/rules/queue${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`,
      z.array(RuleCardSchema),
    ),

  /** Accepts a local path or a GitHub reference; the server decides which it is. */
  learn: (repoPath: string) =>
    send(
      "/api/learn",
      { repoPath },
      z.object({
        label: z.string(),
        proposed: z.number(),
        skipped: z.number(),
        source: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("local"), path: z.string() }),
            z.object({
              kind: z.literal("github"),
              repo: z.string(),
              branch: z.string(),
              headSha: z.string(),
              commits: z.number(),
              historyFrom: z.string(),
              fromCache: z.boolean(),
            }),
          ])
          .optional(),
      }),
    ),

  confirmRule: async (id: string): Promise<void> => {
    await send(`/api/rules/${id}/confirm`, undefined, Ack);
  },
  rejectRule: async (id: string): Promise<void> => {
    await send(`/api/rules/${id}/reject`, undefined, Ack);
  },
  editRule: async (id: string, statement: string): Promise<void> => {
    await send(`/api/rules/${id}/edit`, { statement }, Ack);
  },
};

function act(action: string) {
  return async (incrementId: string): Promise<void> => {
    await send(`/api/increments/${incrementId}/${action}`, undefined, Ack);
  };
}

/** Anything thrown by this client or by React Query, as a sentence. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    return e.status === 409 ? `Not allowed right now: ${e.message}` : e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
