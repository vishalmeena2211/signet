// The console API. Thin: validate in, call services, contracts-shaped out.
// Host-header guard applied globally in main.ts (DNS-rebinding defence).

import { z } from "zod";
import { Body, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { FeatureProposer } from "../services/feature-proposer.js";
import type { RepoDiscovery } from "../services/repo-discovery.js";
import type { AutomationStore } from "../services/automation-store.js";
import type { WorkflowEngine } from "../services/workflow-engine.js";
import {
  AnswerEscalationRequestSchema,
  CreateFeatureRequestSchema,
  EditRuleRequestSchema,
  FeatureIdSchema,
  IncrementIdSchema,
  IncrementDiffViewSchema,
  LearnRequestSchema,
  ProposeFeatureRequestSchema,
  RepoOptionsResponseSchema,
  AutomationStateSchema,
  AutomationControlRequestSchema,
  RecipeSchema,
  CreateRecipeRequestSchema,
  WorkflowSchema,
  SaveWorkflowRequestSchema,
  WorkflowRunViewSchema,
  RoutineFiringSchema,
  ApproveDesignRequestSchema,
  DispatcherControlRequestSchema,
  DispatcherStateSchema,
  GithubRepoListSchema,
  RunIdSchema,
  MergeRequestSchema,
  SendBackRequestSchema,
  FenceAnswerRequestSchema,
  BaselineRequestSchema,
  AskRequestSchema,
  conflict,
} from "@signet/contracts";
import type { WorkViews } from "../services/work-views.js";
import type { BaselineChecks } from "../services/baseline-checks.js";
import type { AwaySummaryService } from "../services/away-summary.js";
import type { PlaceViews, StepViews } from "../services/place-views.js";
import type { ProposalsInFlight } from "../services/feature-events.js";
import type { TakeBack } from "../services/take-back.js";
import { healthLines, type HealthDeps } from "../services/health-lines.js";
import { glance, portrait, type RepoNotes } from "../services/portrait.js";
import type { ConsoleViews } from "../services/console-views.js";
import type { Signatures } from "../services/signatures.js";
import type { Controls } from "../services/controls.js";
import type { RuleStore } from "../services/rule-store.js";
import type { DesignStore } from "../services/design-store.js";
import type { DiffReader } from "../services/diff-reader.js";
import type { OperatorViews } from "../services/operator-views.js";
import type { OperatorStateStore } from "../services/operator-state.js";
import type { SystemInfoService } from "../services/system-info.js";
import type { ContextGraphService } from "../services/context-graph.js";
import { parseGithubRef, type GithubConnector } from "../services/github-connector.js";
import type { Dispatcher } from "../services/dispatcher.js";
import type { Realtime } from "./realtime.gateway.js";

export const TOKENS = {
  views: "signet.views",
  signatures: "signet.signatures",
  controls: "signet.controls",
  rules: "signet.rules",
  designs: "signet.designs",
  diffs: "signet.diffs",
  operator: "signet.operator",
  operatorState: "signet.operatorState",
  system: "signet.system",
  graph: "signet.graph",
  github: "signet.github",
  dispatcher: "signet.dispatcherControl",
  realtime: "signet.realtime",
  activeWorkers: "signet.activeWorkers",
  proposer: "signet.proposer",
  repos: "signet.repos",
  automation: "signet.automation",
  workflows: "signet.workflows",
  work: "signet.work",
  baseline: "signet.baseline",
  away: "signet.away",
  events: "signet.events",
  inFlight: "signet.inFlight",
  places: "signet.places",
  steps: "signet.steps",
  takeBack: "signet.takeBack",
  health: "signet.healthDeps",
  notes: "signet.repoNotes",
} as const;

@Controller("api")
export class ApiController {
  constructor(
    @Inject(TOKENS.views) private readonly views: ConsoleViews,
    @Inject(TOKENS.signatures) private readonly signatures: Signatures,
    @Inject(TOKENS.controls) private readonly controls: Controls,
    @Inject(TOKENS.rules) private readonly rules: RuleStore,
    @Inject(TOKENS.designs) private readonly designs: DesignStore,
    @Inject(TOKENS.diffs) private readonly diffs: DiffReader,
    @Inject(TOKENS.realtime) private readonly realtime: Realtime,
    @Inject(TOKENS.operator) private readonly operator: OperatorViews,
    @Inject(TOKENS.operatorState) private readonly operatorState: OperatorStateStore,
    // `system_` because `system` is the route handler's name.
    @Inject(TOKENS.system) private readonly system_: SystemInfoService,
    // `graph_` because `graph` is the route handler's name.
    @Inject(TOKENS.graph) private readonly graph_: ContextGraphService,
    @Inject(TOKENS.github) private readonly github: GithubConnector,
    @Inject(TOKENS.dispatcher) private readonly dispatcher: Dispatcher,
    @Inject(TOKENS.activeWorkers) private readonly activeWorkers: () => number,
    @Inject(TOKENS.proposer) private readonly proposer: FeatureProposer,
    @Inject(TOKENS.repos) private readonly repos: RepoDiscovery,
    @Inject(TOKENS.automation) private readonly automation: AutomationStore,
    @Inject(TOKENS.workflows) private readonly workflowEngine: WorkflowEngine,
    @Inject(TOKENS.work) private readonly work: WorkViews,
    @Inject(TOKENS.baseline) private readonly baseline: BaselineChecks,
    @Inject(TOKENS.away) private readonly away: AwaySummaryService,
    @Inject(TOKENS.places) private readonly places: PlaceViews,
    @Inject(TOKENS.inFlight) private readonly inFlight: ProposalsInFlight,
    @Inject(TOKENS.steps) private readonly steps: StepViews,
    @Inject(TOKENS.takeBack) private readonly takeBack: TakeBack,
    @Inject(TOKENS.health) private readonly healthDeps: HealthDeps,
    @Inject(TOKENS.notes) private readonly notes: RepoNotes,
  ) {}

  /** First run: the repo, as Signet read it. Free — no model call. */
  @Get("repos/portrait")
  async repoPortrait(@Query("repoId") repoId?: string) {
    const repo = this.repos.resolve(repoId);
    return portrait({ id: repoId ?? repo.path, label: repo.label, path: repo.path }, this.notes);
  }

  /** One line about a repo, for the first-run list. */
  @Get("repos/glance")
  async repoGlance(@Query("repoId") repoId?: string) {
    return glance(this.repos.resolve(repoId).path);
  }

  /** A correction to the portrait, kept with the repo. */
  @Post("repos/notes")
  async repoNote(@Body() body: unknown) {
    const req = z.object({ repoId: z.string().optional(), note: z.string().min(1).max(500) }).parse(body);
    await this.notes.set(this.repos.resolve(req.repoId).path, req.note);
    return { saved: true };
  }

  /** Workshop · Health: one fact per line, and the fix for a failing one. */
  @Get("health/lines")
  async healthView() {
    return healthLines(this.healthDeps);
  }

  /** Take a landed step back: a revert, as a new step waiting for your seal. */
  @Post("increments/:id/take-back")
  async startTakeBack(@Param("id") id: string) {
    const res = await this.takeBack.start(IncrementIdSchema.parse(id));
    this.realtime.broadcast({ kind: "increment_changed", incrementId: IncrementIdSchema.parse(res.incrementId) });
    return res;
  }

  // ── asking ──

  /** What the survey found in the repo — free, and shown while anything else is worked out. */
  @Post("ask/survey")
  async askSurvey(@Body() body: unknown) {
    const req = z.object({ repoId: z.string().optional() }).parse(body ?? {});
    return this.proposer.survey(req.repoId);
  }

  /** The questions worth asking before a plan exists. */
  @Post("ask/questions")
  async askQuestions(@Body() body: unknown) {
    const req = AskRequestSchema.parse(body);
    const done = this.inFlight.begin(req.goal, this.repos.resolve(req.repoId).label);
    const res = await this.proposer.questions(req.goal, req.repoId).finally(done);
    if (!res.ok) throw res.error;
    return res.questions;
  }

  /** Every file in the repo, for pointing at one with @. */
  @Get("repos/files")
  async repoFiles(@Query("repoId") repoId?: string) {
    return { files: await this.proposer.files(repoId) };
  }

  /** What a step in this repo usually costs, from the last twelve built here. */
  @Get("estimate")
  async estimate(@Query("repoId") repoId?: string) {
    return this.steps.likelyCost(this.repos.resolve(repoId).path);
  }

  /** Everything a signing sheet shows about one step. */
  @Get("increments/:id/sheet")
  async sheet(@Param("id") id: string) {
    return this.steps.sheet(IncrementIdSchema.parse(id));
  }

  /** Which branch the step's repo is on — watched while a seal sheet is open. */
  @Get("increments/:id/checkout")
  async checkout(@Param("id") id: string) {
    return this.steps.checkout(IncrementIdSchema.parse(id));
  }

  // ── the three places ──

  /** The Desk: every decision waiting on a person, and the six flow counts. */
  @Get("desk")
  async desk() {
    return this.places.desk();
  }

  /** A feature as one timeline. */
  @Get("features/:id/thread")
  async thread(@Param("id") id: string) {
    return this.places.thread(FeatureIdSchema.parse(id));
  }

  @Get("flow/canal")
  async canal() {
    return this.places.canal();
  }

  @Get("flow/ledger")
  async ledger() {
    return this.places.ledger();
  }

  // ── watching and judging a step ──

  /** What the agent is doing: its own to-do list, its actions, and the map of where it has been. */
  @Get("runs/:id/work")
  async runWork(@Param("id") id: string) {
    const view = await this.work.runWork(RunIdSchema.parse(id));
    if (!view) throw new NotFoundException();
    return view;
  }

  /** Each promise in "done when", with the test that proves it or why nothing does. */
  @Get("increments/:id/promises")
  async promises(@Param("id") id: string) {
    return this.work.promises(IncrementIdSchema.parse(id));
  }

  /** Notes on lines of the change: back to the agent instead of landing. */
  @Post("increments/:id/send-back")
  async sendBack(@Param("id") id: string, @Body() body: unknown) {
    const incId = IncrementIdSchema.parse(id);
    const req = SendBackRequestSchema.parse(body);
    const res = await this.controls.sendBack(incId, req.notes);
    this.realtime.broadcast({ kind: "increment_changed", incrementId: incId });
    return res;
  }

  /** "May I change files outside the fence" — answered with a choice. */
  @Post("escalations/:id/fence")
  async answerFence(@Param("id") id: string, @Body() body: unknown) {
    const req = FenceAnswerRequestSchema.parse(body);
    const { startNow } = await this.controls.answerFence(id, req);
    // Widening the fence or staying inside it carries on: the answer is the new initial.
    const started = startNow ? await this.signatures.approve(startNow) : null;
    if (startNow) this.realtime.broadcast({ kind: "increment_changed", incrementId: IncrementIdSchema.parse(startNow) });
    return { answered: true, runId: started?.runId ?? null };
  }

  /** The checks run once against main: can they run here, and do they pass before any change. */
  @Post("repos/baseline")
  async runBaseline(@Body() body: unknown) {
    const req = BaselineRequestSchema.parse(body ?? {});
    const repo = this.repos.resolve(req.repoId);
    if (repo.origin === "github") {
      throw Object.assign(new Error("github repo"), {
        signet: conflict("baseline.github", "Checks run against a local clone. Clone the repository and pick it by path."),
      });
    }
    return this.baseline.run({ path: repo.path, label: repo.label }, this.signatures.base);
  }

  @Get("repos/baseline")
  async lastBaseline(@Query("repoId") repoId?: string) {
    const repo = this.repos.resolve(repoId);
    return { report: await this.baseline.last(repo.path) };
  }

  /** What happened since the person last looked. */
  @Get("away")
  async awaySummary(@Query("since") since?: string) {
    // Validated like every other input, so a malformed date is a 400 with a reason.
    const iso = z.iso.datetime().optional().parse(since);
    return this.away.summary(iso ? new Date(iso) : new Date(Date.now() - 12 * 60 * 60_000));
  }

  @Get("health")
  async health() {
    const quota = await this.views.quotaState(this.activeWorkers());
    return { ok: true, quota };
  }

  @Get("features")
  async features() {
    return this.views.featuresBoard();
  }

  // ── operator visibility: the whole instance, not one feature ──

  @Get("overview")
  async overview() {
    return this.operator.overview();
  }

  @Get("runs")
  async runs(@Query("outcome") outcome?: string, @Query("incrementId") incrementId?: string, @Query("limit") limit?: string) {
    const n = Number(limit ?? 100);
    return this.operator.runs({
      ...(outcome ? { outcome } : {}),
      ...(incrementId ? { incrementId } : {}),
      limit: Number.isFinite(n) ? Math.min(Math.max(n, 1), 500) : 100,
    });
  }

  @Get("runs/:id")
  async run(@Param("id") id: string) {
    const detail = await this.operator.runDetail(RunIdSchema.parse(id));
    if (!detail) throw new NotFoundException();
    return detail;
  }

  /** What the agent knew when it wrote the code. */
  @Get("increments/:id/pack")
  async pack(@Param("id") id: string) {
    const view = await this.operator.pack(IncrementIdSchema.parse(id));
    if (!view) throw new NotFoundException();
    return view;
  }

  @Get("activity")
  async activityFeed(@Query("limit") limit?: string) {
    const n = Number(limit ?? 100);
    return this.operator.activityFeed(Number.isFinite(n) ? Math.min(Math.max(n, 1), 500) : 100);
  }

  @Get("system")
  async system() {
    return this.system_.info();
  }

  /**
   * The repositories the operator's GitHub login can see, for the picker. Cached
   * by the client; never fails the field, since typing a path must always work.
   */
  @Get("github/repos")
  async githubRepos() {
    return GithubRepoListSchema.parse(await this.github.listRepos());
  }

  /** The context graph of everything learned, and what it notices about itself. */
  @Get("graph")
  async graph(@Query("repo") repo?: string) {
    return this.graph_.build(repo ? { repo } : {});
  }

  // ── operational control ──

  @Get("dispatcher")
  async dispatcherState() {
    return DispatcherStateSchema.parse(this.dispatcher.state());
  }

  /**
   * Hold or release the whole pipeline, and change the worker ceiling. Held
   * work stays in the outbox, so this is a pause rather than a cancellation.
   */
  @Post("dispatcher")
  async controlDispatcher(@Body() body: unknown) {
    const req = DispatcherControlRequestSchema.parse(body);
    if (req.paused !== undefined) this.dispatcher.setPaused(req.paused);
    if (req.maxWorkers !== undefined) this.dispatcher.setMaxWorkers(req.maxWorkers);
    const state = this.dispatcher.state();
    // Remember the decision so a restart does not silently resume.
    await this.operatorState.save({ paused: state.paused, maxWorkers: state.maxWorkers });
    this.realtime.broadcast({ kind: "quota_changed" });
    return DispatcherStateSchema.parse(state);
  }

  @Get("features/:id")
  async feature(@Param("id") id: string) {
    // No try/catch swallowing everything into a 404. A missing feature raises a
    // typed not_found that the error filter maps to 404 with a reason; anything
    // else — a parse failure on corrupt state, a database fault — is a real
    // problem and must say so, rather than claiming the feature does not exist.
    const detail = await this.views.featureDetail(id);
    const verdicts: Record<string, unknown> = {};
    const activity: Record<string, unknown> = {};
    for (const inc of detail.increments) {
      verdicts[inc.id] = await this.views.latestVerdicts(inc.id);
      activity[inc.id] = await this.views.activity(inc.id);
    }
    const escalations = await this.views.openEscalations(id);
    return { ...detail, verdicts, activity, escalations };
  }

  // ── automation ──
  //
  // Nothing here can merge. A workflow runs work up to the point of landing it and then
  // stops, because signature 2 stays human. That is enforced in the engine, not here.

  @Get("automation")
  async automationState() {
    return AutomationStateSchema.parse(await this.automation.state());
  }

  @Post("automation")
  async setAutomation(@Body() body: unknown) {
    const req = AutomationControlRequestSchema.parse(body);
    this.workflowEngine.setPaused(req.paused);
    return AutomationStateSchema.parse(await this.automation.state());
  }

  @Get("recipes")
  async listRecipes() {
    return z.array(RecipeSchema).parse(await this.automation.listRecipes());
  }

  @Post("recipes")
  async createRecipe(@Body() body: unknown) {
    return this.automation.createRecipe(CreateRecipeRequestSchema.parse(body));
  }

  @Delete("recipes/:id")
  async deleteRecipe(@Param("id") id: string) {
    await this.automation.deleteRecipe(id);
    return { ok: true };
  }

  @Get("workflows")
  async listWorkflows() {
    return z.array(WorkflowSchema).parse(await this.automation.listWorkflows());
  }

  @Post("workflows")
  async saveWorkflow(@Body() body: unknown) {
    return this.automation.saveWorkflow(SaveWorkflowRequestSchema.parse(body));
  }

  @Post("workflows/:id/enabled")
  async setWorkflowEnabled(@Param("id") id: string, @Body() body: unknown) {
    const req = z.object({ enabled: z.boolean() }).parse(body);
    await this.automation.setWorkflowEnabled(id, req.enabled);
    return { ok: true };
  }

  @Delete("workflows/:id")
  async deleteWorkflow(@Param("id") id: string) {
    await this.automation.deleteWorkflow(id);
    return { ok: true };
  }

  /**
   * Runs a workflow now. Always allowed, even while automation is paused: the switch
   * exists to stop things firing while nobody is watching, and a person pressing a button
   * is not the thing being guarded against.
   */
  @Post("workflows/:id/run")
  async runWorkflow(@Param("id") id: string) {
    const result = await this.workflowEngine.run(id, { triggeredBy: "manual" });
    if ("skipped" in result) {
      await this.workflowEngine.recordSkip(id, "manual", result.reason);
      return { started: false, reason: result.reason };
    }
    return { started: true, runId: result.runId };
  }

  @Get("workflow-runs")
  async workflowRuns() {
    return z.array(WorkflowRunViewSchema).parse(await this.automation.listRuns());
  }

  /** One routine's recent firings, for drawing over its canvas. */
  @Get("workflows/:id/firings")
  async routineFirings(@Param("id") id: string) {
    return z.array(RoutineFiringSchema).parse(await this.automation.firings(id));
  }

  /** Takes a stopped routine off the Desk; its firing and reason stay in the history. */
  @Post("workflow-runs/:id/dismiss")
  async dismissRoutineStop(@Param("id") id: string) {
    await this.automation.dismissStop(id);
    return { dismissed: true };
  }

  /**
   * Every repository work can be sent to: local git repos found on this machine, plus
   * the user's github repos. Each says whether a run can actually finish there, so the
   * push limitation is visible at the point of choosing rather than at the merge.
   */
  @Get("repos")
  async repoOptions() {
    return RepoOptionsResponseSchema.parse(await this.repos.list());
  }

  /**
   * Proposes a breakdown from a plain description, and persists NOTHING. The user
   * reviews what comes back and creates the feature from it, so a bad proposal costs
   * one model call and no rows.
   *
   * Surveying is deterministic and free; the model call is not, which is why this is a
   * deliberate user action rather than something that fires as they type.
   */
  @Post("propose")
  async propose(@Body() body: unknown) {
    const req = ProposeFeatureRequestSchema.parse(body);
    // Visible in the canal's first reach while it is being worked out.
    const done = this.inFlight.begin(req.goal, this.repos.resolve(req.repoId).label);
    const result = await this.proposer.propose(req).finally(done);
    // Thrown so the error filter maps it to a status and a sentence, rather than
    // returning 200 with a failure inside — the console would have to learn a second
    // way of discovering something went wrong.
    if (!result.ok) throw result.error;
    return result.response;
  }

  @Post("features")
  async createFeature(@Body() body: unknown) {
    const req = CreateFeatureRequestSchema.parse(body);
    const res = await this.controls.createFeature(req);
    this.realtime.broadcast({ kind: "feature_changed", featureId: FeatureIdSchema.parse(res.featureId) });
    return res;
  }

  @Post("escalations/:id/answer")
  async answerEscalation(@Param("id") id: string, @Body() body: unknown) {
    const req = AnswerEscalationRequestSchema.parse(body);
    const incrementId = await this.controls.answerEscalation(id, req.answer);
    // Answering is agreeing to carry on: the step starts again from where it stopped.
    const started = await this.signatures.approve(incrementId);
    this.realtime.broadcast({ kind: "increment_changed", incrementId: IncrementIdSchema.parse(incrementId) });
    return { answered: true, runId: started.runId };
  }

  @Post("increments/:id/retry")
  async retry(@Param("id") id: string) {
    const incId = IncrementIdSchema.parse(id);
    await this.controls.retry(incId);
    this.realtime.broadcast({ kind: "increment_changed", incrementId: incId });
    return { retried: true };
  }

  @Post("increments/:id/dismiss")
  async dismiss(@Param("id") id: string) {
    const incId = IncrementIdSchema.parse(id);
    await this.controls.dismiss(incId);
    this.realtime.broadcast({ kind: "increment_changed", incrementId: incId });
    return { dismissed: true };
  }

  @Post("increments/:id/abort")
  async abort(@Param("id") id: string) {
    const incId = IncrementIdSchema.parse(id);
    const res = await this.controls.abort(incId);
    this.realtime.broadcast({ kind: "increment_changed", incrementId: incId });
    return res;
  }

  // ── design of record (the approved ground truth the conformance gate judges) ──

  @Post("increments/:id/design")
  async approveDesign(@Param("id") id: string, @Body() body: unknown) {
    const incId = IncrementIdSchema.parse(id);
    const req = ApproveDesignRequestSchema.parse(body);
    const record = await this.designs.approve(incId, {
      source: req.source,
      approvedBy: req.approvedBy,
      intent: req.intent,
      ...(req.referenceImagePath ? { referenceImagePath: req.referenceImagePath } : {}),
    });
    this.realtime.broadcast({ kind: "increment_changed", incrementId: incId });
    return { approved: true, intent: record.intent };
  }

  @Get("increments/:id/design")
  async getDesign(@Param("id") id: string) {
    const record = await this.designs.get(IncrementIdSchema.parse(id));
    if (!record) throw new NotFoundException();
    return record;
  }

  /** Signature 2 needs evidence: what did the agent actually change. */
  @Get("increments/:id/diff")
  async diff(@Param("id") id: string) {
    return IncrementDiffViewSchema.parse(await this.diffs.read(IncrementIdSchema.parse(id)));
  }

  // ── design-system learner + confirmation queue ──

  /**
   * Learn from a local path OR a GitHub reference — a URL, an ssh remote, or just
   * owner/repo. A GitHub source is cloned shallowly into a cache first and then
   * read exactly like a local one, so the learner needs no knowledge of where the
   * code came from.
   */
  @Post("learn")
  async learn(@Body() body: unknown) {
    const req = LearnRequestSchema.parse(body);
    const github = looksLikeGithub(req.repoPath) ? parseGithubRef(req.repoPath) : null;

    if (github) {
      const cloned = await this.github.fetchRepo(req.repoPath);
      const label = req.label ?? cloned.label;
      const res = await this.rules.learn(cloned.path, label);
      this.realtime.broadcast({ kind: "quota_changed" });
      return {
        label,
        ...res,
        // Report the history actually available: the trend miner's conclusions are
        // only as good as the window, and a shallow clone that does not reach back
        // far enough would otherwise read as "this convention did not exist".
        source: {
          kind: "github" as const,
          repo: `${github.owner}/${github.repo}`,
          branch: cloned.defaultBranch,
          headSha: cloned.headSha.slice(0, 8),
          commits: cloned.commitCount,
          historyFrom: cloned.oldestCommitDate,
          fromCache: cloned.fromCache,
        },
      };
    }

    const label = req.label ?? req.repoPath.split("/").filter(Boolean).pop() ?? "repo";
    const res = await this.rules.learn(req.repoPath, label);
    this.realtime.broadcast({ kind: "quota_changed" }); // cheap nudge to refresh the queue
    return { label, ...res, source: { kind: "local" as const, path: req.repoPath } };
  }

  @Get("rules/queue")
  async ruleQueue(@Query("repo") repo?: string) {
    return this.rules.queue(repo);
  }

  @Post("rules/:id/confirm")
  async confirmRule(@Param("id") id: string) {
    await this.rules.confirm(id);
    this.realtime.broadcast({ kind: "quota_changed" });
    return { confirmed: true };
  }

  @Post("rules/:id/reject")
  async rejectRule(@Param("id") id: string) {
    await this.rules.reject(id);
    this.realtime.broadcast({ kind: "quota_changed" });
    return { rejected: true };
  }

  @Post("rules/:id/edit")
  async editRule(@Param("id") id: string, @Body() body: unknown) {
    const req = EditRuleRequestSchema.parse(body);
    await this.rules.edit(id, req);
    return { edited: true };
  }

  @Post("increments/:id/approve")
  async approve(@Param("id") id: string) {
    const incId = IncrementIdSchema.parse(id);
    const res = await this.signatures.approve(incId);
    this.realtime.broadcast({ kind: "increment_changed", incrementId: incId });
    return res;
  }

  @Post("increments/:id/merge")
  async merge(@Param("id") id: string, @Body() body: unknown) {
    const incId = IncrementIdSchema.parse(id);
    const req = MergeRequestSchema.parse(body ?? {});
    await this.signatures.merge(incId, { onTrust: req.onTrust });
    this.realtime.broadcast({ kind: "increment_changed", incrementId: incId });
    return { merged: true };
  }
}

/**
 * A local absolute path is never a GitHub reference; anything else that parses as
 * one is treated as one. Checked before parsing so `/Users/me/owner/repo` cannot
 * be mistaken for `owner/repo`.
 */
function looksLikeGithub(input: string): boolean {
  const s = input.trim();
  if (s.startsWith("/") || s.startsWith("~") || s.startsWith(".")) return false;
  return /github\.com/.test(s) || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);
}
