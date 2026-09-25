// The console API. Thin: validate in, call services, contracts-shaped out.
// Host-header guard applied globally in main.ts (DNS-rebinding defence).

import { Body, Controller, Get, Inject, NotFoundException, Param, Post } from "@nestjs/common";
import {
  AnswerEscalationRequestSchema,
  CreateFeatureRequestSchema,
  FeatureIdSchema,
  IncrementIdSchema,
} from "@signet/contracts";
import type { ConsoleViews } from "../services/console-views.js";
import type { Signatures } from "../services/signatures.js";
import type { Controls } from "../services/controls.js";
import type { Realtime } from "./realtime.gateway.js";

export const TOKENS = {
  views: "signet.views",
  signatures: "signet.signatures",
  controls: "signet.controls",
  realtime: "signet.realtime",
  activeWorkers: "signet.activeWorkers",
} as const;

@Controller("api")
export class ApiController {
  constructor(
    @Inject(TOKENS.views) private readonly views: ConsoleViews,
    @Inject(TOKENS.signatures) private readonly signatures: Signatures,
    @Inject(TOKENS.controls) private readonly controls: Controls,
    @Inject(TOKENS.realtime) private readonly realtime: Realtime,
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
