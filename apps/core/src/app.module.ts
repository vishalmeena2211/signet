// The master, assembled. Constructor injection via factory providers — plain
// wiring, no magic: config parses or the process refuses to start; the
// dispatcher and completer start with the app and stop with it.

import {
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Inject,
} from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  EscalationIdSchema,
  FeatureIdSchema,
  IncrementIdSchema,
  parseConfig,
  type SignetConfig,
} from "@signet/contracts";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "./persistence/generated/client.js";
import { PrismaQuotaStore, PrismaUnitOfWork } from "./persistence/prisma-ports.js";
import { WorktreeManager } from "./domain/runtime/worktree-manager.js";
import { ClaudeAdapter } from "./domain/adapter/claude-adapter.js";
import { GateSuite } from "./domain/gates/gate-runner.js";
import { lintGate, testsGate, typecheckGate } from "./domain/gates/standard-gates.js";
import { rulesGate } from "./domain/gates/rules-gate.js";
import { makeRunOnBase } from "./domain/gates/base-overlay.js";
import { checkScope } from "./domain/pipeline/scope-checker.js";
import { RunEngine } from "./services/run-engine.js";
import { ClaudeAgentDriver } from "./services/claude-agent-driver.js";
import { PackAssemblerV0 } from "./services/pack-assembler.js";
import { Dispatcher, recoverOrphanedRuns } from "./services/dispatcher.js";
import { ConsoleViews } from "./services/console-views.js";
import { Signatures } from "./services/signatures.js";
import { Controls } from "./services/controls.js";
import { RuleStore } from "./services/rule-store.js";
import { ApiController, TOKENS } from "./http/api.controller.js";
import { Realtime } from "./http/realtime.gateway.js";
import { makeLogger } from "./boot/logger.js";
import type { Logger } from "./domain/runtime/logger.js";

const CONFIG = "signet.config";
const PRISMA = "signet.prisma";
const UOW = "signet.uow";
const LOGGER = "signet.logger";
const DISPATCHER = "signet.dispatcher";

function buildDispatcher(
  cfg: SignetConfig,
  uow: PrismaUnitOfWork,
  db: PrismaClient,
  log: Logger,
  realtime: Realtime,
  rules: RuleStore,
): Dispatcher {
  const worktrees = new WorktreeManager(cfg.targetRepoPath, cfg.workspacesRoot);
  const adapter = new ClaudeAdapter({ binary: cfg.claudeBinary, timeoutMs: 20 * 60_000 }, log);
  const driver = new ClaudeAgentDriver(adapter, { maxTurns: 60 });
  const targetLabel = cfg.targetRepoPath.split("/").filter(Boolean).pop() ?? "repo";
  const gates = new GateSuite(
    [
      typecheckGate(),
      lintGate(),
      testsGate({ runOnBase: makeRunOnBase() }),
      rulesGate({ loadConfirmedRules: () => rules.confirmedRules(targetLabel) }), // warn-first
    ],
    async (runId, v) => {
      await db.gateVerdict.create({
        data: {
          id: randomUUID(),
          runId,
          gate: v.gate,
          outcome: v.outcome,
          findingsJson: JSON.stringify(v.findings),
        },
      });
    },
    log,
  );
  const packAssembler = new PackAssemblerV0(
    cfg.packsRoot,
    {
      async loadIncrement(id) {
        const row = await db.increment.findUniqueOrThrow({ where: { id } });
        const brief = await db.briefVersion.findUniqueOrThrow({ where: { id: row.briefVersionId } });
        return {
          title: row.title,
          declaredSurface: row.declaredSurface,
          briefVersionId: row.briefVersionId,
          briefContentMd: brief.contentMd,
          acceptanceMd: "",
          handoffNote: null,
        };
      },
    },
    uow,
  );
  const engine = new RunEngine(
    uow,
    worktrees,
    driver,
    {
      async runAll(input) {
        const res = await gates.runAll(input);
        return res.passed
          ? { passed: true }
          : {
              passed: false,
              repairFeedback: res.repairFeedback,
              error: res.error ?? { kind: "recoverable", code: "gates.failed", message: "gates failed" },
            };
      },
    },
    packAssembler,
    { check: checkScope },
    {
      baseRef: cfg.baseRef,
      maxRepairIterations: cfg.maxRepairIterations,
      maxFreshRestarts: cfg.maxFreshRestarts,
    },
    log,
  );
  const quota = new PrismaQuotaStore(db);
  return new Dispatcher(
    uow,
    engine,
    quota,
    { maxConcurrentWorkers: cfg.maxConcurrentWorkers, pollIntervalMs: 1000 },
    log,
    async (_runId, incrementId, outcome) => {
      const incId = IncrementIdSchema.parse(incrementId);
      await uow
        .run(async (tx) => {
          const row = await tx.increments.get(incId);
          if (!row) return;
          if (outcome.outcome === "succeeded" && row.state.status === "RUNNING") {
            // Two legal steps — the machine (correctly) refuses the shortcut.
            await tx.increments.transition(incId, "RUNNING", {
              status: "VERIFYING",
              runId: row.state.runId,
            });
            await tx.increments.transition(incId, "VERIFYING", {
              status: "AWAITING_SIGNATURE",
              runId: row.state.runId,
            });
          } else if (outcome.outcome === "escalated" && row.state.status === "RUNNING") {
            const escalationId = randomUUID();
            await db.escalation.create({
              data: {
                id: escalationId,
                incrementId: incId,
                status: "RAISED",
                stateJson: JSON.stringify({ status: "RAISED", question: outcome.question }),
              },
            });
            await tx.increments.transition(incId, "RUNNING", {
              status: "ESCALATED",
              escalationId: EscalationIdSchema.parse(escalationId),
            });
          } else if (outcome.outcome === "failed" && row.state.status === "RUNNING") {
            await tx.increments.transition(incId, "RUNNING", {
              status: "FAILED",
              reason: outcome.error.message,
            });
          }
        })
        .catch((e) => log.error("post_run.transition_failed", { error: String(e) }));

      realtime.broadcast({ kind: "increment_changed", incrementId: incId });
      const inc = await db.increment.findUnique({ where: { id: incrementId } });
      if (inc) {
        const featureId = FeatureIdSchema.parse(inc.featureId);
        realtime.broadcast({ kind: "feature_changed", featureId });
        if (outcome.outcome === "escalated") {
          realtime.broadcast({ kind: "needs_you", featureId, why: "An increment raised a question." });
        }
      }
    },
  );
}

@Module({
  controllers: [ApiController],
  providers: [
    { provide: CONFIG, useFactory: () => parseConfig(process.env) },
    { provide: LOGGER, useFactory: (cfg: SignetConfig) => makeLogger(cfg.logLevel), inject: [CONFIG] },
    {
      provide: PRISMA,
      useFactory: (cfg: SignetConfig) =>
        new PrismaClient({ adapter: new PrismaPg({ connectionString: cfg.databaseUrl }) }),
      inject: [CONFIG],
    },
    { provide: UOW, useFactory: (db: PrismaClient) => new PrismaUnitOfWork(db), inject: [PRISMA] },
    { provide: TOKENS.realtime, useFactory: (log: Logger) => new Realtime(log), inject: [LOGGER] },
    { provide: TOKENS.views, useFactory: (db: PrismaClient) => new ConsoleViews(db), inject: [PRISMA] },
    {
      provide: TOKENS.signatures,
      useFactory: (uow: PrismaUnitOfWork, cfg: SignetConfig) =>
        new Signatures(uow, cfg.targetRepoPath, cfg.baseRef),
      inject: [UOW, CONFIG],
    },
    {
      provide: TOKENS.rules,
      useFactory: (db: PrismaClient, log: Logger) => new RuleStore(db, log),
      inject: [PRISMA, LOGGER],
    },
    {
      provide: DISPATCHER,
      useFactory: buildDispatcher,
      inject: [CONFIG, UOW, PRISMA, LOGGER, TOKENS.realtime, TOKENS.rules],
    },
    {
      provide: TOKENS.controls,
      useFactory: (db: PrismaClient, uow: PrismaUnitOfWork, dispatcher: Dispatcher) =>
        new Controls(db, uow, dispatcher),
      inject: [PRISMA, UOW, DISPATCHER],
    },
    {
      provide: TOKENS.activeWorkers,
      useFactory: (dispatcher: Dispatcher) => () => dispatcher.activeWorkers(),
      inject: [DISPATCHER],
    },
  ],
  exports: [],
})
export class AppModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(DISPATCHER) private readonly dispatcher: Dispatcher,
    @Inject(UOW) private readonly uow: PrismaUnitOfWork,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const recovered = await recoverOrphanedRuns(this.uow, this.log);
    if (recovered > 0) this.log.warn("boot.orphans_recovered", { count: recovered });
    this.dispatcher.start();
    this.log.info("boot.dispatcher_started");
  }

  async onApplicationShutdown(): Promise<void> {
    await this.dispatcher.stop();
    await this.prisma.$disconnect();
  }
}
