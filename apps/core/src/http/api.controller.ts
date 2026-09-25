// The console API. Thin: validate in, call services, contracts-shaped out.
// Host-header guard applied globally in main.ts (DNS-rebinding defence).

import { Controller, Get, Inject, NotFoundException, Param, Post } from "@nestjs/common";
import { IncrementIdSchema } from "@signet/contracts";
import type { ConsoleViews } from "../services/console-views.js";
import type { Signatures } from "../services/signatures.js";
import type { Realtime } from "./realtime.gateway.js";

export const TOKENS = {
  views: "signet.views",
  signatures: "signet.signatures",
  realtime: "signet.realtime",
  activeWorkers: "signet.activeWorkers",
} as const;

@Controller("api")
export class ApiController {
  constructor(
    @Inject(TOKENS.views) private readonly views: ConsoleViews,
    @Inject(TOKENS.signatures) private readonly signatures: Signatures,
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
      for (const inc of detail.increments) {
        verdicts[inc.id] = await this.views.latestVerdicts(inc.id);
      }
      return { ...detail, verdicts };
    } catch {
      throw new NotFoundException();
    }
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
