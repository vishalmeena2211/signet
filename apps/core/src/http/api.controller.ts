// The console API. Thin: validate in, call services, contracts-shaped out.
// Host-header guard applied globally in main.ts (DNS-rebinding defence).

import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query } from "@nestjs/common";
import {
  AnswerEscalationRequestSchema,
  CreateFeatureRequestSchema,
  EditRuleRequestSchema,
  FeatureIdSchema,
  IncrementIdSchema,
  IncrementDiffViewSchema,
  LearnRequestSchema,
  ApproveDesignRequestSchema,
  DispatcherControlRequestSchema,
  DispatcherStateSchema,
  RunIdSchema,
} from "@signet/contracts";
import type { ConsoleViews } from "../services/console-views.js";
import type { Signatures } from "../services/signatures.js";
import type { Controls } from "../services/controls.js";
import type { RuleStore } from "../services/rule-store.js";
import type { DesignStore } from "../services/design-store.js";
import type { DiffReader } from "../services/diff-reader.js";
import type { OperatorViews } from "../services/operator-views.js";
import type { OperatorStateStore } from "../services/operator-state.js";
import type { SystemInfoService } from "../services/system-info.js";
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
  dispatcher: "signet.dispatcherControl",
  realtime: "signet.realtime",
  activeWorkers: "signet.activeWorkers",
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
    @Inject(TOKENS.dispatcher) private readonly dispatcher: Dispatcher,
    @Inject(TOKENS.activeWorkers) private readonly activeWorkers: () => number,
  ) {}

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
    try {
      const detail = await this.views.featureDetail(id);
      const verdicts: Record<string, unknown> = {};
      const activity: Record<string, unknown> = {};
      for (const inc of detail.increments) {
        verdicts[inc.id] = await this.views.latestVerdicts(inc.id);
        activity[inc.id] = await this.views.activity(inc.id);
      }
      const escalations = await this.views.openEscalations(id);
      return { ...detail, verdicts, activity, escalations };
    } catch {
      throw new NotFoundException();
    }
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
    await this.controls.answerEscalation(id, req.answer);
    return { answered: true };
  }

  @Post("increments/:id/retry")
  async retry(@Param("id") id: string) {
    const incId = IncrementIdSchema.parse(id);
    await this.controls.retry(incId);
    this.realtime.broadcast({ kind: "increment_changed", incrementId: incId });
    return { retried: true };
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

  @Post("learn")
  async learn(@Body() body: unknown) {
    const req = LearnRequestSchema.parse(body);
    const label = req.label ?? req.repoPath.split("/").filter(Boolean).pop() ?? "repo";
    const res = await this.rules.learn(req.repoPath, label);
    this.realtime.broadcast({ kind: "quota_changed" }); // cheap nudge to refresh the queue
    return { label, ...res };
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
  async merge(@Param("id") id: string) {
    const incId = IncrementIdSchema.parse(id);
    await this.signatures.merge(incId);
    this.realtime.broadcast({ kind: "increment_changed", incrementId: incId });
    return { merged: true };
  }
}
