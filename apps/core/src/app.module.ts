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
import { WorktreeManager, removeWorktreeFor } from "./domain/runtime/worktree-manager.js";
import { ClaudeAdapter } from "./domain/adapter/claude-adapter.js";
import { FeatureProposer, proposalToCreateRequest } from "./services/feature-proposer.js";
import { RepoDiscovery } from "./services/repo-discovery.js";
import { WorkflowEngine } from "./services/workflow-engine.js";
import { AutomationStore } from "./services/automation-store.js";
import { AutomationEvents } from "./services/automation-events.js";
import { GateSuite } from "./domain/gates/gate-runner.js";
import { lintGate, testsGate, typecheckGate } from "./domain/gates/standard-gates.js";
import { rulesGate } from "./domain/gates/rules-gate.js";
import { conformanceGate } from "./domain/gates/conformance-gate.js";
import { PROOFS_FILE, promisesGate } from "./domain/gates/promises-gate.js";
import { AgentWorkLog, toAgentAction } from "./services/agent-work.js";
import { WorkViews } from "./services/work-views.js";
import { BaselineChecks } from "./services/baseline-checks.js";
import { AwaySummaryService } from "./services/away-summary.js";
import { writeFile } from "node:fs/promises";
import { FeatureEvents, ProposalsInFlight } from "./services/feature-events.js";
import { PlaceViews, StepViews, type PlaceDeps } from "./services/place-views.js";
import { TakeBack } from "./services/take-back.js";
import { RepoNotes } from "./services/portrait.js";
import { makeRunOnBase } from "./domain/gates/base-overlay.js";
import { DesignStore } from "./services/design-store.js";
import { join } from "node:path";
import { DiffReader } from "./services/diff-reader.js";
import { OperatorViews } from "./services/operator-views.js";
import { OperatorStateStore } from "./services/operator-state.js";
import { SystemInfoService } from "./services/system-info.js";
import { ContextGraphService } from "./services/context-graph.js";
import { GithubConnector } from "./services/github-connector.js";
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
const EVENTS = "signet.automationEvents";
const WORKLOG = "signet.workLog";
const PLACE_DEPS = "signet.placeDeps";

function placeDeps(
  cfg: SignetConfig,
  db: PrismaClient,
  diffs: DiffReader,
  work: WorkViews,
  log: AgentWorkLog,
  proposals: ProposalsInFlight,
  views: ConsoleViews,
): PlaceDeps {
  return {
    db,
    diffs,
    work,
    log,
    proposals,
    quota: () => views.quotaState(0),
    configuredRepoLabel: cfg.targetRepoPath.split("/").filter(Boolean).pop() ?? "repo",
    configuredRepoPath: cfg.targetRepoPath,
    baseRef: cfg.baseRef,
  };
}

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
  events: AutomationEvents,
  workLog: AgentWorkLog,
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
      promisesGate({ packsRoot: cfg.packsRoot }), // never blocks the run; the seal holds on it
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
          // Was hardcoded to "" here, which meant every context pack ever assembled
          // shipped an empty acceptance.md — no agent had been told what "done" meant
          // for the step it was working on. The e2e suites passed their own value in
          // through a side map, so the tests agreed with the broken wiring.
          acceptanceMd: row.acceptanceMd,
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
    {
      // A run builds into the repo its FEATURE targets, not whichever one this instance
      // was started with. Without this a feature pointed at another repo would have its
      // worktree branched from the wrong codebase and quietly produce a diff against it.
      async forIncrement(incrementId) {
        const inc = await db.increment.findUnique({
          where: { id: incrementId },
          select: { feature: { select: { repoPath: true, repoLabel: true, repoOrigin: true } } },
        });
        const f = inc?.feature;
        return {
          path: f?.repoPath ?? cfg.targetRepoPath,
          label: f?.repoLabel ?? cfg.targetRepoPath,
          // A github repo can be planned against but not merged into, so the run
          // refuses before spending anything rather than failing at the merge.
          canMerge: (f?.repoOrigin ?? "local") !== "github",
        };
      },
    },
  );
  // Watching, not deciding: every hook is best-effort inside the engine, so a full disk
  // or a slow socket can cost a view and never a run.
  const lastBroadcast = new Map<string, number>();
  engine.hooks = {
    async onAgentEvent({ runId, incrementId, phase, workspacePath, event }) {
      const action = toAgentAction(event, phase, workspacePath, new Date());
      if (!action) return;
      await workLog.append(runId, action);
      // At most one redraw a second per run: an agent can make several calls a second,
      // and a screen that repaints on every one is harder to read, not easier.
      const now = Date.now();
      if (now - (lastBroadcast.get(runId) ?? 0) > 1000) {
        lastBroadcast.set(runId, now);
        realtime.broadcast({ kind: "run_activity", runId, incrementId });
      }
    },
    // The closing message is where the agent names the test for each promise; the
    // promises gate reads it from beside the pack, as it reads acceptance.md.
    async onImplementResult({ packDir, resultText }) {
      await writeFile(join(packDir, PROOFS_FILE), resultText, "utf8");
    },
  };
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
                stateJson: JSON.stringify({
                  status: "RAISED",
                  question: outcome.question,
                  ...(outcome.fence ? { fence: outcome.fence } : {}),
                  ...(outcome.options ? { options: outcome.options } : {}),
                  ...(outcome.why ? { why: outcome.why } : {}),
                }),
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
            // The run id is carried so a workflow cannot react to a failure its own run
            // produced — the same guard that stops a merge-triggered loop.
            void events.publish("run_failed", { runId: _runId });
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
    { provide: EVENTS, useFactory: (log: Logger) => new AutomationEvents(log), inject: [LOGGER] },
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
    { provide: WORKLOG, useFactory: (cfg: SignetConfig) => new AgentWorkLog(cfg.packsRoot), inject: [CONFIG] },
    { provide: TOKENS.events, useFactory: (db: PrismaClient) => new FeatureEvents(db), inject: [PRISMA] },
    { provide: TOKENS.inFlight, useFactory: () => new ProposalsInFlight() },
    {
      provide: PLACE_DEPS,
      useFactory: (
        cfg: SignetConfig,
        db: PrismaClient,
        diffs: DiffReader,
        work: WorkViews,
        log: AgentWorkLog,
        proposals: ProposalsInFlight,
        views: ConsoleViews,
      ) =>
        placeDeps(cfg, db, diffs, work, log, proposals, views),
      inject: [CONFIG, PRISMA, TOKENS.diffs, TOKENS.work, WORKLOG, TOKENS.inFlight, TOKENS.views],
    },
    {
      provide: TOKENS.places,
      useFactory: (deps: PlaceDeps) => new PlaceViews(deps),
      inject: [PLACE_DEPS],
    },
    {
      provide: TOKENS.notes,
      useFactory: (cfg: SignetConfig) => new RepoNotes(join(cfg.workspacesRoot, "..", "repo-notes.json")),
      inject: [CONFIG],
    },
    {
      provide: TOKENS.health,
      useFactory: (cfg: SignetConfig, db: PrismaClient, baseline: BaselineChecks) => ({
        db,
        repoPath: cfg.targetRepoPath,
        baseRef: cfg.baseRef,
        workspacesRoot: cfg.workspacesRoot,
        claudeBinary: cfg.claudeBinary,
        baseline,
      }),
      inject: [CONFIG, PRISMA, TOKENS.baseline],
    },
    {
      provide: TOKENS.takeBack,
      useFactory: (cfg: SignetConfig, db: PrismaClient) =>
        new TakeBack({ db, workspacesRoot: cfg.workspacesRoot, configuredRepoPath: cfg.targetRepoPath, baseRef: cfg.baseRef }),
      inject: [CONFIG, PRISMA],
    },
    {
      provide: TOKENS.steps,
      useFactory: (deps: PlaceDeps) => new StepViews(deps),
      inject: [PLACE_DEPS],
    },
    {
      provide: TOKENS.work,
      useFactory: (db: PrismaClient, log: AgentWorkLog) => new WorkViews(db, log),
      inject: [PRISMA, WORKLOG],
    },
    {
      provide: TOKENS.baseline,
      // Beside operator-state.json, for the same reason: it belongs to this instance's
      // data, not to any repository.
      useFactory: (cfg: SignetConfig) =>
        new BaselineChecks({
          typecheck: typecheckGate(),
          tests: testsGate({ runOnBase: makeRunOnBase() }),
          storePath: join(cfg.workspacesRoot, "..", "baselines.json"),
        }),
      inject: [CONFIG],
    },
    { provide: TOKENS.away, useFactory: (db: PrismaClient) => new AwaySummaryService(db), inject: [PRISMA] },
    {
      provide: TOKENS.signatures,
      useFactory: (uow: PrismaUnitOfWork, cfg: SignetConfig, db: PrismaClient, work: WorkViews, events: FeatureEvents) => {
          const signatures = new Signatures(uow, cfg.targetRepoPath, cfg.baseRef);
          // The seal holds on unproven promises unless the person chooses to seal on trust.
          signatures.unprovenPromises = (incrementId) => work.unproven(incrementId);
          signatures.onSigned = async (e) => {
            await events.record({ incrementId: e.incrementId, kind: e.kind, payload: e.payload });
            // Sealing a take-back is what takes the earlier step back.
            if (e.kind === "merged") {
              const inc = await db.increment.findUnique({ where: { id: e.incrementId }, select: { revertsIncrementId: true } });
              if (inc?.revertsIncrementId) await events.record({ incrementId: inc.revertsIncrementId, kind: "taken_back" });
            }
          };
          // A feature can target its own repo, so the merge has to follow it. Merging
          // into the configured repo regardless would land real commits in the wrong
          // codebase, silently.
          signatures.repoForIncrement = async (incrementId) => {
            const inc = await db.increment.findUnique({
              where: { id: incrementId },
              select: { feature: { select: { repoPath: true } } },
            });
            return inc?.feature.repoPath ?? null;
          };
          return signatures;
      },
      inject: [UOW, CONFIG, PRISMA, TOKENS.work, TOKENS.events],
    },
    {
      provide: TOKENS.rules,
      useFactory: (db: PrismaClient, log: Logger, events: AutomationEvents) => new RuleStore(db, log, events),
      inject: [PRISMA, LOGGER, EVENTS],
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
      provide: TOKENS.graph,
      useFactory: (db: PrismaClient) => new ContextGraphService(db),
      inject: [PRISMA],
    },
    {
      provide: TOKENS.github,
      useFactory: (log: Logger) => new GithubConnector(log),
      inject: [LOGGER],
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
      inject: [CONFIG, UOW, PRISMA, LOGGER, TOKENS.realtime, TOKENS.rules, TOKENS.designs, EVENTS, WORKLOG],
    },
    {
      provide: TOKENS.controls,
      useFactory: (
        db: PrismaClient,
        uow: PrismaUnitOfWork,
        dispatcher: Dispatcher,
        repos: RepoDiscovery,
        events: FeatureEvents,
        diffs: DiffReader,
        cfg: SignetConfig,
      ) => {
        const controls = new Controls(db, uow, dispatcher);
        controls.resolveRepo = (repoId) => repos.resolve(repoId);
        controls.events = events;
        controls.diffs = diffs;
        controls.maxRepairs = cfg.maxRepairIterations;
        return controls;
      },
      inject: [PRISMA, UOW, DISPATCHER, TOKENS.repos, TOKENS.events, TOKENS.diffs, CONFIG],
    },
    {
      provide: TOKENS.activeWorkers,
      useFactory: (dispatcher: Dispatcher) => () => dispatcher.activeWorkers(),
      inject: [DISPATCHER],
    },
    {
      provide: TOKENS.workflows,
      useFactory: (
        db: PrismaClient,
        log: Logger,
        proposer: FeatureProposer,
        controls: Controls,
        signatures: Signatures,
      ) =>
        new WorkflowEngine({
          db,
          log,
          propose: async ({ goal, repoId }) => {
            const res = await proposer.propose({ goal, ...(repoId ? { repoId } : {}) });
            if (!res.ok) return { ok: false, reason: res.error.message };
            const req = proposalToCreateRequest(res.response.proposal);
            return {
              ok: true,
              title: req.title,
              briefMd: req.briefMd,
              increments: req.increments,
              // Carried, not dropped. Without this the engine falls back to a generic
              // "Nothing needed doing." and the agent's actual reasoning — the only
              // useful part of a no-work result — never reaches the screen.
              noWorkNeeded: res.response.proposal.noWorkNeeded,
            };
          },
          createFeature: (input) => controls.createFeature(input),
          // Signature 1 only. There is deliberately no path from here to merge().
          approve: (incrementId, routine) => signatures.approve(incrementId, { routine }),
        }),
      inject: [PRISMA, LOGGER, TOKENS.proposer, TOKENS.controls, TOKENS.signatures],
    },
    {
      provide: TOKENS.automation,
      useFactory: (db: PrismaClient, repos: RepoDiscovery, engine: WorkflowEngine) =>
        new AutomationStore({
          db,
          resolveRepo: (repoId) => repos.resolve(repoId),
          isPaused: () => engine.isPaused(),
        }),
      inject: [PRISMA, TOKENS.repos, TOKENS.workflows],
    },
    {
      provide: TOKENS.repos,
      useFactory: (cfg: SignetConfig, github: GithubConnector) =>
        new RepoDiscovery({
          configuredRepoPath: cfg.targetRepoPath,
          workspacesRoot: cfg.workspacesRoot,
          github,
        }),
      inject: [CONFIG, TOKENS.github],
    },
    {
      provide: TOKENS.proposer,
      // Its own adapter instance with a shorter leash than an implementation run:
      // proposing is one question with no code to write, so a long timeout here would
      // only ever mean something has hung.
      useFactory: (cfg: SignetConfig, log: Logger, repos: RepoDiscovery, github: GithubConnector, notes: RepoNotes) => {
        const adapter = new ClaudeAdapter({ binary: cfg.claudeBinary, timeoutMs: 5 * 60_000 }, log);
        return new FeatureProposer({
          repoNote: (path) => notes.get(path),
          // A github repo has no local path until somebody asks for one, so the clone
          // happens here, on demand, into the cache the learner already uses. Nothing
          // is fetched to populate a dropdown.
          resolveRepo: async (repoId) => {
            const choice = repos.resolve(repoId);
            if (choice.origin !== "github") return choice;
            const cloned = await github.fetchRepo(choice.label);
            return { ...choice, path: cloned.path };
          },
          // The proposer needs one answer, not an event stream, so it declares the
          // narrower interface and the no-op onEvent is supplied here. Widening the
          // proposer's interface to match the adapter would make it harder to fake in
          // tests for no gain.
          adapter: { execute: (input) => adapter.execute({ ...input, onEvent: async () => {} }) },
          targetRepoPath: cfg.targetRepoPath,
          ...(AGENT_MODEL !== null ? { model: AGENT_MODEL } : {}),
        });
      },
      inject: [CONFIG, LOGGER, TOKENS.repos, TOKENS.github, TOKENS.notes],
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
    @Inject(TOKENS.workflows) private readonly workflows: WorkflowEngine,
    @Inject(TOKENS.signatures) private readonly signatures: Signatures,
    @Inject(EVENTS) private readonly events: AutomationEvents,
    @Inject(CONFIG) private readonly cfg: SignetConfig,
    @Inject(TOKENS.views) private readonly views: ConsoleViews,
    @Inject(TOKENS.baseline) private readonly baseline: BaselineChecks,
  ) {}

  /**
   * Whether the Claude quota was exhausted on the previous tick.
   *
   * There is no "quota reset" signal anywhere in the system — only a record of when a
   * window was EXHAUSTED. So the reset is derived by watching the edge: exhausted on the
   * last look, not exhausted now. Starting as false means a process that boots into a
   * healthy state does not immediately claim a reset that nobody observed.
   */
  private quotaWasExhausted = false;

  /** The schedule tick. Cleared on shutdown so a restart does not stack timers. */
  private scheduleTimer: NodeJS.Timeout | null = null;

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

    // Every 30s. Schedules are "roughly now" rather than to-the-second, and the tick
    // deliberately does not replay windows missed while the process was down — see
    // isDue(). A failure here must not take the process with it: automation going quiet
    // is bad, a boot loop is worse.
    this.scheduleTimer = setInterval(() => {
      void (async () => {
        await this.workflows.tick(new Date());
        await this.detectQuotaReset();
        await this.morningChecks();
      })().catch((e: unknown) => {
        this.log.error("automation.tick_failed", { error: String(e) });
      });
    }, 30_000);
    this.scheduleTimer.unref();

    // Wired here rather than in the factories because it is a CYCLE: the workflow engine
    // needs Signatures to approve, so Signatures cannot ask for the engine at
    // construction. Connecting them once both exist breaks it without a lazy getter.
    this.signatures.onMerged = async (incrementId) => {
      await this.workflows.onEvent("step_merged", { runId: incrementId, depth: 0 });
    };

    // Reap the worktree once the work has landed. Nothing did this before, so they
    // accumulated — and once they started carrying a clone of node_modules so the gates
    // could run, one against a real package was 67MB by itself.
    this.signatures.releaseWorktree = async (incrementId) => {
      const inc = await this.prisma.increment.findUnique({
        where: { id: incrementId },
        select: { feature: { select: { repoPath: true } } },
      });
      await removeWorktreeFor({
        workspacesRoot: this.cfg.workspacesRoot,
        repoPath: inc?.feature.repoPath ?? this.cfg.targetRepoPath,
        incrementId,
      });
    };

    // Everything else publishes through the bus, so one subscription covers run_failed
    // and rules_proposed without those services knowing automation exists.
    this.events.subscribe(async (event, cause) => {
      await this.workflows.onEvent(event, cause);
    });
  }

  /**
   * The checks run again on main each morning, so a check that stops working on its own
   * is caught before it blames a step. At most once in twenty hours, and never twice at
   * the same time.
   */
  private checkingMain = false;
  private async morningChecks(): Promise<void> {
    if (this.checkingMain) return;
    const last = await this.baseline.last(this.cfg.targetRepoPath);
    if (last && Date.now() - Date.parse(last.checkedAt) < 20 * 3600_000) return;
    this.checkingMain = true;
    try {
      await this.baseline.run({ path: this.cfg.targetRepoPath, label: this.cfg.targetRepoPath.split("/").pop() ?? "repo" }, this.cfg.baseRef);
    } catch (e) {
      this.log.warn("baseline.morning_failed", { error: String(e) });
    } finally {
      this.checkingMain = false;
    }
  }

  /** Publishes quota_reset on the exhausted -> healthy edge, never on the level. */
  private async detectQuotaReset(): Promise<void> {
    // activeWorkers is irrelevant to exhaustion; 0 keeps this read cheap.
    const quota = await this.views.quotaState(0);
    if (this.quotaWasExhausted && !quota.exhausted) {
      await this.events.publish("quota_reset");
    }
    this.quotaWasExhausted = quota.exhausted;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    await this.dispatcher.stop();
    await this.prisma.$disconnect();
  }
}
