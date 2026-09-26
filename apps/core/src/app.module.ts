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
import { conformanceGate } from "./domain/gates/conformance-gate.js";
import { makeRunOnBase } from "./domain/gates/base-overlay.js";
import { DesignStore } from "./services/design-store.js";
import { join } from "node:path";
import { DiffReader } from "./services/diff-reader.js";
import { OperatorViews } from "./services/operator-views.js";
import { OperatorStateStore } from "./services/operator-state.js";
import { SystemInfoService } from "./services/system-info.js";
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
export const LOGGER = "signet.logger";
const DISPATCHER = "signet.dispatcher";

/**
 * Left unpinned so a run uses whatever the operator's Claude Code is configured
 * to use — we drive their subscription, we do not choose their model. Tests pin
 * a cheap model explicitly; the System screen reports this value as it is, so
 * "not pinned" shows as exactly that rather than a model we never requested.
 */
const AGENT_MODEL: string | null = null;

function buildDispatcher(
  cfg: SignetConfig,
  uow: PrismaUnitOfWork,
  db: PrismaClient,
  log: Logger,
  realtime: Realtime,
  rules: RuleStore,
  designs: DesignStore,
): Dispatcher {
  const worktrees = new WorktreeManager(cfg.targetRepoPath, cfg.workspacesRoot);
  const adapter = new ClaudeAdapter({ binary: cfg.claudeBinary, timeoutMs: 20 * 60_000 }, log);
  const driver = new ClaudeAgentDriver(adapter, {
    maxTurns: 60,
    ...(AGENT_MODEL !== null ? { model: AGENT_MODEL } : {}),
  });
  const targetLabel = cfg.targetRepoPath.split("/").filter(Boolean).pop() ?? "repo";
  const gates = new GateSuite(
    [
      typecheckGate(),
      lintGate(),
      testsGate({ runOnBase: makeRunOnBase() }),
      rulesGate({ loadConfirmedRules: () => rules.confirmedRules(targetLabel) }), // warn-first
      conformanceGate({ loadDesign: (incId) => designs.get(incId) }), // blocks: the design was signed
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
        const design = await designs.get(id);
        return {
          title: row.title,
          declaredSurface: row.declaredSurface,
          briefVersionId: row.briefVersionId,
          briefContentMd: brief.contentMd,
          acceptanceMd: "",
          handoffNote: null,
          designSliceMd: design ? designs.renderSlice(design) : null,
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
      provide: TOKENS.designs,
      useFactory: (db: PrismaClient) => new DesignStore(db),
      inject: [PRISMA],
    },
    {
      provide: TOKENS.diffs,
      useFactory: (cfg: SignetConfig) => new DiffReader(cfg.workspacesRoot, cfg.baseRef),
      inject: [CONFIG],
    },
    {
      provide: TOKENS.operatorState,
      // Lives beside the workspaces so one instance's operator decisions travel
      // with its data directory rather than the repository checkout.
      useFactory: (cfg: SignetConfig, log: Logger) =>
        new OperatorStateStore(join(cfg.workspacesRoot, "..", "operator-state.json"), log),
      inject: [CONFIG, LOGGER],
    },
    {
      provide: TOKENS.system,
      useFactory: (cfg: SignetConfig, db: PrismaClient) => new SystemInfoService(cfg, db, AGENT_MODEL),
      inject: [CONFIG, PRISMA],
    },
    {
      provide: TOKENS.operator,
      useFactory: (db: PrismaClient, views: ConsoleViews, dispatcher: Dispatcher) =>
        new OperatorViews(db, {
          quotaState: (n) => views.quotaState(n),
          activeWorkers: () => dispatcher.activeWorkers(),
          dispatcherState: () => dispatcher.state(),
        }),
      inject: [PRISMA, TOKENS.views, DISPATCHER],
    },
    // The controller injects the dispatcher for pause/resume; aliasing keeps the
    // controller's token vocabulary consistent with its other dependencies.
    { provide: TOKENS.dispatcher, useExisting: DISPATCHER },
    {
      provide: DISPATCHER,
      useFactory: buildDispatcher,
      inject: [CONFIG, UOW, PRISMA, LOGGER, TOKENS.realtime, TOKENS.rules, TOKENS.designs],
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
    @Inject(TOKENS.operatorState) private readonly operatorState: OperatorStateStore,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const recovered = await recoverOrphanedRuns(this.uow, this.log);
    if (recovered > 0) this.log.warn("boot.orphans_recovered", { count: recovered });

    // Restore the operator's decisions BEFORE starting: a system someone paused
    // must not resume work just because the process restarted.
    const saved = await this.operatorState.load();
    if (saved.maxWorkers !== undefined) this.dispatcher.setMaxWorkers(saved.maxWorkers);
    if (saved.paused) this.dispatcher.setPaused(true);

    this.dispatcher.start();
    this.log.info("boot.dispatcher_started", this.dispatcher.state());
  }

  async onApplicationShutdown(): Promise<void> {
    await this.dispatcher.stop();
    await this.prisma.$disconnect();
  }
}
