// RunEngine integration test against in-memory fakes + a real git worktree.
// Proves the full loop shape — plan → scope → implement → gates → finalize —
// plus the repair loop, quota parking, scope escalation, and the refusal path,
// with no database and no real agent.

import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  IncrementIdSchema,
  RunIdSchema,
  SessionRefSchema,
  recoverable,
  type IncrementId,
  type ModelUsage,
  type RunId,
  type RunState,
  type SessionRef,
} from "@signet/contracts";
import type {
  EffectJournal,
  IncrementRepo,
  IncrementRow,
  Outbox,
  RunRepo,
  RunRow,
  TxPorts,
  UnitOfWork,
} from "../domain/runtime/ports.js";
import type { Logger } from "../domain/runtime/logger.js";
import { WorktreeManager } from "../domain/runtime/worktree-manager.js";
import { RunEngine, type AgentDriver, type GateRunner, type PackAssembler } from "./run-engine.js";

const exec = promisify(execFile);

// ── in-memory ports ──────────────────────────────────────────────────────────

class MemIncrements implements IncrementRepo {
  rows = new Map<string, IncrementRow>();
  async get(id: IncrementId) {
    const row = this.rows.get(id);
    // A COPY, deliberately.
    //
    // This fake used to hand back the live object out of the map, which made it more
    // forgiving than the real repository — Prisma maps each read into a fresh object, so
    // mutating what `get()` returned writes to nothing.
    //
    // That difference hid a genuine unbounded loop: the engine incremented
    // `row.repairAttempt` in place, the fake happily kept it because it was the same
    // reference, and the budget-exhaustion test below passed. In production the counter
    // never moved and one step spent 49 gate rounds and 57 agent spawns.
    //
    // A double that is laxer than the thing it stands in for does not reduce risk, it
    // relocates it to where nobody is looking.
    return row ? { ...row, state: { ...row.state } } : null;
  }
  async transition(id: IncrementId, _from: never, state: IncrementRow["state"]) {
    const row = this.rows.get(id);
    if (row) row.state = state;
  }
  async listByStatus() {
    return [...this.rows.values()];
  }
  async setBudget(id: IncrementId, budget: { repairAttempt?: number; freshRestarts?: number }) {
    const row = this.rows.get(id);
    if (!row) return;
    if (budget.repairAttempt !== undefined) row.repairAttempt = budget.repairAttempt;
    if (budget.freshRestarts !== undefined) row.freshRestarts = budget.freshRestarts;
  }
}

class MemRuns implements RunRepo {
  states = new Map<string, RunState>();
  sessions = new Map<string, SessionRef>();
  workspaces = new Map<string, string>();
  usage: ModelUsage[] = [];
  phases: Array<{ phase: string; attempt: number; completed: boolean }> = [];
  async create(runId: RunId) {
    this.states.set(runId, { status: "CREATED" });
  }
  async get(runId: RunId): Promise<RunRow | null> {
    const state = this.states.get(runId);
    if (!state) return null;
    return {
      id: runId,
      incrementId: IncrementIdSchema.parse("11111111-aaaa-4bbb-8ccc-000000000ddd"),
      state,
      workspacePath: this.workspaces.get(runId) ?? null,
      sessionRef: this.sessions.get(runId) ?? null,
    };
  }
  async setState(runId: RunId, state: RunState) {
    this.states.set(runId, state);
  }
  async setSessionRef(runId: RunId, ref: SessionRef) {
    this.sessions.set(runId, ref);
  }
  async setWorkspacePath(runId: RunId, path: string) {
    this.workspaces.set(runId, path);
  }
  async listInPhase() {
    return [];
  }
  async enterPhase(_runId: RunId, phase: string, attempt: number) {
    this.phases.push({ phase, attempt, completed: false });
  }
  async completePhase(_runId: RunId, phase: string, attempt: number) {
    const p = this.phases.find((x) => x.phase === phase && x.attempt === attempt && !x.completed);
    if (p) p.completed = true;
  }
  async recordUsage(_runId: RunId, usage: ModelUsage[]) {
    this.usage.push(...usage);
  }
  async saveManifest() {}
}

const memEffects: EffectJournal = {
  async journal(input) {
    return {
      id: "33333333-aaaa-4bbb-8ccc-000000000001" as never,
      runId: input.runId,
      phase: input.phase,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      status: "JOURNALED",
      payloadJson: input.payloadJson,
      attempt: 1,
    };
  },
  async markExecuting() {},
  async markDone() {},
  async markFailed() {},
  async byStatus() {
    return [];
  },
};
const memOutbox: Outbox = {
  async enqueue() {},
  async claimDue() {
    return [];
  },
  async markProcessed() {},
  async release() {},
};

const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};

// ── fixture repo ─────────────────────────────────────────────────────────────

let repo: string;
let workspaces: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "signet-engine-repo-"));
  workspaces = await mkdtemp(join(tmpdir(), "signet-engine-ws-"));
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "app.ts"), "export const x = 1;\n");
  await exec("git", ["add", "-A"], { cwd: repo });
  await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], { cwd: repo });
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(workspaces, { recursive: true, force: true });
});

// ── harness ──────────────────────────────────────────────────────────────────

const INC = IncrementIdSchema.parse("11111111-aaaa-4bbb-8ccc-000000000ddd");
const RUN = RunIdSchema.parse("22222222-aaaa-4bbb-8ccc-000000000eee");
const SESSION = SessionRefSchema.parse("sess-fixture-1");

function makeHarness(opts: {
  agentImplement: AgentDriver["implement"];
  gateResults: Array<{ passed: boolean; feedback?: string }>;
  planFiles?: string[];
  /** Called once per gate round, so a test can COUNT them rather than infer the bound. */
  onGateRound?: () => void;
}) {
  const increments = new MemIncrements();
  increments.rows.set(INC, {
    id: INC,
    featureId: "f",
    title: "test increment",
    state: { status: "RUNNING", runId: RUN },
    declaredSurface: ["app.ts", "feature.ts"],
    repairAttempt: 0,
    freshRestarts: 0,
  });
  const runs = new MemRuns();
  void runs.create(RUN);

  const uow: UnitOfWork = {
    async run(fn) {
      const tx: TxPorts = { increments, runs, effects: memEffects, outbox: memOutbox };
      return fn(tx);
    },
  };

  const agent: AgentDriver = {
    async plan() {
      return {
        ok: true,
        plan: {
          approach: "edit feature.ts",
          filesToTouch: opts.planFiles ?? ["feature.ts"],
          risks: [],
        },
        sessionRef: SESSION,
        usage: [{ model: "claude-opus-5", inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 }],
      };
    },
    implement: opts.agentImplement,
  };

  let gateCall = 0;
  const gates: GateRunner = {
    async runAll() {
      const r = opts.gateResults[Math.min(gateCall, opts.gateResults.length - 1)];
      gateCall += 1;
      opts.onGateRound?.();
      if (!r) throw new Error("no gate result configured");
      return r.passed
        ? { passed: true }
        : {
            passed: false,
            repairFeedback: r.feedback ?? "tests failed",
            error: recoverable("gates.tests_failed", r.feedback ?? "tests failed"),
          };
    },
  };

  const packs: PackAssembler = {
    async assemble() {
      return { packDir: join(workspaces, "pack"), declaredSurface: ["app.ts", "feature.ts"] };
    },
  };

  const engine = new RunEngine(
    uow,
    new WorktreeManager(repo, workspaces),
    agent,
    gates,
    packs,
    {
      check(planFiles, surface) {
        const outside = planFiles.filter((f) => !surface.includes(f));
        return outside.length === 0 ? { inScope: true } : { inScope: false, outside };
      },
    },
    { baseRef: "main", maxRepairIterations: 3, maxFreshRestarts: 1 },
    nullLogger,
  );

  return { engine, runs, increments };
}

const writingImplement =
  (marker: string): AgentDriver["implement"] =>
  async ({ workspacePath, onEvent }) => {
    await writeFile(join(workspacePath, "feature.ts"), `export const built = "${marker}";\n`);
    await onEvent({ type: "session_started", sessionRef: SESSION });
    await onEvent({
      type: "usage_update",
      perModel: [{ model: "claude-opus-5", inputTokens: 500, cachedInputTokens: 100, outputTokens: 200 }],
    });
    return { ok: true, sessionRef: SESSION };
  };

// ── the tests ────────────────────────────────────────────────────────────────

let cleanupIds: string[] = [];
beforeEach(() => {
  cleanupIds = [];
});

describe("run engine — full loop", () => {
  it("happy path: all phases complete in order, usage recorded, run SUCCEEDED", async () => {
    const h = makeHarness({ agentImplement: writingImplement("v1"), gateResults: [{ passed: true }] });
    const outcome = await h.engine.execute(RUN, INC, "ASSEMBLE_PACK", 1);
    expect(outcome).toEqual({ outcome: "succeeded" });
    expect(h.runs.states.get(RUN)).toEqual({ status: "SUCCEEDED" });
    expect(h.runs.phases.map((p) => p.phase)).toEqual([
      "ASSEMBLE_PACK",
      "CREATE_WORKSPACE",
      "AGENT_PLAN",
      "SCOPE_CHECK",
      "AGENT_IMPLEMENT",
      "GATES",
      "FINALIZE",
    ]);
    expect(h.runs.phases.every((p) => p.completed)).toBe(true);
    expect(h.runs.usage.length).toBeGreaterThanOrEqual(2); // plan + implement
    cleanupIds.push(INC);
  });

  it("repair loop: failed gates re-run AGENT_IMPLEMENT with feedback, then succeed", async () => {
    let feedbackSeen: string | null = null;
    const impl: AgentDriver["implement"] = async (input) => {
      if (input.repairFeedback) feedbackSeen = input.repairFeedback;
      return writingImplement("v2")(input);
    };
    const h = makeHarness({
      agentImplement: impl,
      gateResults: [{ passed: false, feedback: "expected 2, got 1" }, { passed: true }],
    });
    const outcome = await h.engine.execute(RUN, INC, "ASSEMBLE_PACK", 1);
    expect(outcome).toEqual({ outcome: "succeeded" });
    expect(feedbackSeen).toBe("expected 2, got 1");
    const implementPhases = h.runs.phases.filter((p) => p.phase === "AGENT_IMPLEMENT");
    expect(implementPhases.length).toBe(2);
  });

  it("out-of-scope plan → failed with scope.outside_surface (escalation upstream)", async () => {
    const h = makeHarness({
      agentImplement: writingImplement("v3"),
      gateResults: [{ passed: true }],
      planFiles: ["secrets/prod.env"],
    });
    const outcome = await h.engine.execute(RUN, INC, "ASSEMBLE_PACK", 1);
    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome !== "failed") return;
    expect(outcome.error.code).toBe("scope.outside_surface");
  });

  it("quota limit mid-implement → parked with the reset time, no repair burned", async () => {
    const resetsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const impl: AgentDriver["implement"] = async ({ onEvent }) => {
      await onEvent({
        type: "limit_reached",
        limitKind: "five_hour",
        resetsAt,
        rawMessage: "5-hour limit reached",
      });
      return { ok: false, error: recoverable("adapter.limit_reached", "limit") };
    };
    const h = makeHarness({ agentImplement: impl, gateResults: [{ passed: true }] });
    const outcome = await h.engine.execute(RUN, INC, "ASSEMBLE_PACK", 1);
    expect(outcome.outcome).toBe("parked");
    if (outcome.outcome !== "parked") return;
    expect(outcome.resumeAt?.toISOString()).toBe(resetsAt);
    const inc = await h.increments.get(INC);
    expect(inc?.repairAttempt).toBe(0);
  });

  it("budget exhaustion escalates with a human-readable question", async () => {
    const h = makeHarness({
      agentImplement: writingImplement("v5"),
      gateResults: [{ passed: false }], // fails forever
    });
    const outcome = await h.engine.execute(RUN, INC, "ASSEMBLE_PACK", 1);
    expect(outcome.outcome).toBe("escalated");
    if (outcome.outcome !== "escalated") return;
    expect(outcome.question).toMatch(/repair budget/);
  });

  it("PERSISTS the repair counter, so the budget can actually run out", async () => {
    // The assertion that was missing. The test above only checked that escalation
    // eventually happened, which the fake satisfied by letting the engine mutate its own
    // row in place. Against the real repository the counter never moved, and "fails
    // forever" meant exactly that: 49 gate rounds on one step.
    //
    // Asserting the counter lands in the REPOSITORY is what makes the bound real.
    const h = makeHarness({
      agentImplement: writingImplement("v6"),
      gateResults: [{ passed: false }],
    });
    await h.engine.execute(RUN, INC, "ASSEMBLE_PACK", 1);
    const row = await h.increments.get(INC);
    expect(row?.repairAttempt).toBe(3); // maxRepairIterations
    expect(row?.freshRestarts).toBe(1); // maxFreshRestarts
  });

  it("stops after a bounded number of gate rounds", async () => {
    // Counted rather than inferred. An unbounded loop is not a slow failure, it is an
    // expensive one: every round is a fresh agent spawn against the user's subscription.
    let rounds = 0;
    const h = makeHarness({
      agentImplement: writingImplement("v7"),
      gateResults: [{ passed: false }],
      onGateRound: () => {
        rounds += 1;
      },
    });
    await h.engine.execute(RUN, INC, "ASSEMBLE_PACK", 1);
    // 3 repairs + 1 fresh restart, each with its own gate round, plus the first.
    expect(rounds).toBeLessThanOrEqual(12);
    expect(rounds).toBeGreaterThan(1);
  });
});

afterAll(async () => {
  // worktrees for INC may remain (FINALIZE keeps them for review) — clean.
  await rm(join(workspaces, `inc-${INC}`), { recursive: true, force: true }).catch(() => {});
});
