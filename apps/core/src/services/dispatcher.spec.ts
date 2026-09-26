import { describe, expect, it } from "vitest";
import {
  IncrementIdSchema,
  RunIdSchema,
  type IncrementId,
  type ModelUsage,
  type OutboxMessage,
  type RunId,
  type RunState,
  type SessionRef,
} from "@signet/contracts";
import type {
  EffectJournal,
  IncrementRepo,
  Outbox,
  QuotaStore,
  RunRepo,
  RunRow,
  TxPorts,
  UnitOfWork,
} from "../domain/runtime/ports.js";
import type { Logger } from "../domain/runtime/logger.js";
import { Dispatcher, enqueueRun, recoverOrphanedRuns } from "./dispatcher.js";
import type { RunEngine, RunOutcome } from "./run-engine.js";

const INC = IncrementIdSchema.parse("11111111-aaaa-4bbb-8ccc-000000000d01");

const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};

class MemOutbox implements Outbox {
  rows: Array<OutboxMessage & { processed: boolean; claimed: boolean }> = [];
  private n = 0;
  async enqueue(msg: Omit<OutboxMessage, "id">): Promise<void> {
    this.rows.push({ id: `m${++this.n}`, ...msg, processed: false, claimed: false });
  }
  async claimDue(n: number): Promise<OutboxMessage[]> {
    const due = this.rows.filter(
      (r) => !r.processed && !r.claimed && new Date(r.availableAt).getTime() <= Date.now(),
    );
    const take = due.slice(0, n);
    for (const t of take) t.claimed = true;
    return take.map(({ id, topic, payloadJson, availableAt }) => ({ id, topic, payloadJson, availableAt }));
  }
  async markProcessed(id: string): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.processed = true;
  }
  async release(id: string): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.claimed = false;
  }
}

class MemRuns implements RunRepo {
  rows = new Map<string, RunRow>();
  async create(runId: RunId, incrementId: IncrementId) {
    this.rows.set(runId, { id: runId, incrementId, state: { status: "CREATED" }, workspacePath: null, sessionRef: null });
  }
  async get(runId: RunId) {
    return this.rows.get(runId) ?? null;
  }
  async setState(runId: RunId, state: RunState) {
    const r = this.rows.get(runId);
    if (r) r.state = state;
  }
  async setSessionRef(runId: RunId, ref: SessionRef) {
    const r = this.rows.get(runId);
    if (r) r.sessionRef = ref;
  }
  async setWorkspacePath() {}
  async listInPhase() {
    return [...this.rows.values()].filter((r) => r.state.status === "PHASE");
  }
  async enterPhase() {}
  async completePhase() {}
  async recordUsage(_r: RunId, _u: ModelUsage[]) {}
  async saveManifest() {}
}

function makeWorld(engineBehavior: (runId: RunId) => Promise<RunOutcome>) {
  const outbox = new MemOutbox();
  const runs = new MemRuns();
  const uow: UnitOfWork = {
    async run(fn) {
      return fn({
        increments: {} as IncrementRepo,
        runs,
        effects: {} as EffectJournal,
        outbox,
      } satisfies TxPorts);
    },
  };
  let inFlight = 0;
  let maxInFlight = 0;
  const engine = {
    async execute(runId: RunId): Promise<RunOutcome> {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await engineBehavior(runId);
      } finally {
        inFlight -= 1;
      }
    },
  } as unknown as RunEngine;

  const quotaState = { exhausted: false, resetsAt: null as Date | null };
  const quota: QuotaStore = {
    async recordExhausted(_k, resetsAt) {
      quotaState.exhausted = true;
      quotaState.resetsAt = resetsAt;
    },
    async current() {
      return quotaState.exhausted
        ? { kind: "five_hour", exhausted: true, resetsAt: quotaState.resetsAt }
        : null;
    },
    async clearExhausted() {
      quotaState.exhausted = false;
    },
  };

  const outcomes: RunOutcome[] = [];
  const dispatcher = new Dispatcher(
    uow,
    engine,
    quota,
    { maxConcurrentWorkers: 2, pollIntervalMs: 999999 },
    nullLogger,
    async (_r, _i, o) => {
      outcomes.push(o);
    },
  );
  return { outbox, runs, uow, dispatcher, outcomes, quota, maxInFlight: () => maxInFlight };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("dispatcher", () => {
  it("enqueueRun creates the run and a due dispatch message; tick executes it", async () => {
    const w = makeWorld(async () => ({ outcome: "succeeded" }));
    const runId = await enqueueRun(w.uow, INC);
    expect(w.runs.rows.has(runId)).toBe(true);
    await w.dispatcher.tick();
    await settle();
    expect(w.outcomes).toEqual([{ outcome: "succeeded" }]);
    expect(w.outbox.rows[0]?.processed).toBe(true);
  });

  it("respects the concurrency cap of 2 across a burst of 5", async () => {
    const w = makeWorld(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return { outcome: "succeeded" };
    });
    for (let i = 0; i < 5; i++) await enqueueRun(w.uow, INC);
    await w.dispatcher.tick(); // claims 2
    await w.dispatcher.tick(); // no free slots -> claims 0
    await settle();
    await w.dispatcher.tick();
    await new Promise((r) => setTimeout(r, 80));
    await w.dispatcher.tick();
    await new Promise((r) => setTimeout(r, 80));
    expect(w.maxInFlight()).toBeLessThanOrEqual(2);
    expect(w.outcomes.length).toBeGreaterThanOrEqual(4);
  });

  it("parked outcome records quota, re-enqueues a future resume, and the quota gate stops dispatch", async () => {
    const resetsAt = new Date(Date.now() + 3600_000);
    const w = makeWorld(async () => ({ outcome: "parked", resumeAt: resetsAt }));
    await enqueueRun(w.uow, INC);
    await w.dispatcher.tick();
    await settle();
    const resume = w.outbox.rows.find((r) => r.topic === "run.resume");
    expect(resume).toBeTruthy();
    expect(new Date(resume?.availableAt ?? 0).getTime()).toBe(resetsAt.getTime());
    // window now exhausted: nothing more dispatches even with due messages
    await enqueueRun(w.uow, INC);
    const before = w.outcomes.length;
    await w.dispatcher.tick();
    await settle();
    expect(w.outcomes.length).toBe(before);
  });

  it("poison payloads are marked processed, never redelivered forever", async () => {
    const w = makeWorld(async () => ({ outcome: "succeeded" }));
    await w.uow.run(async (tx) =>
      tx.outbox.enqueue({ topic: "run.dispatch", payloadJson: "{not json", availableAt: new Date().toISOString() }),
    );
    await w.dispatcher.tick();
    await settle();
    expect(w.outbox.rows[0]?.processed).toBe(true);
    expect(w.outcomes).toHaveLength(0);
  });

  it("engine crash releases the claim for redelivery", async () => {
    let calls = 0;
    const w = makeWorld(async () => {
      calls += 1;
      if (calls === 1) throw new Error("engine exploded");
      return { outcome: "succeeded" };
    });
    await enqueueRun(w.uow, INC);
    await w.dispatcher.tick();
    await settle();
    expect(w.outbox.rows[0]?.processed).toBe(false);
    expect(w.outbox.rows[0]?.claimed).toBe(false); // released
    await w.dispatcher.tick();
    await settle();
    expect(w.outcomes).toEqual([{ outcome: "succeeded" }]);
  });
});

describe("completer", () => {
  it("re-queues mid-phase orphans from their recovery point", async () => {
    const w = makeWorld(async () => ({ outcome: "succeeded" }));
    const orphan = RunIdSchema.parse("22222222-aaaa-4bbb-8ccc-000000000e01");
    await w.runs.create(orphan, INC);
    await w.runs.setState(orphan, { status: "PHASE", phase: "GATES", attempt: 1 });
    const n = await recoverOrphanedRuns(w.uow, nullLogger);
    expect(n).toBe(1);
    const msg = w.outbox.rows.find((r) => r.topic === "run.resume");
    expect(msg?.payloadJson).toContain('"startPhase":"GATES"');
    expect(msg?.payloadJson).toContain('"attempt":2'); // bumped
  });

  it("interrupted implement with a session resumes at the same attempt", async () => {
    const w = makeWorld(async () => ({ outcome: "succeeded" }));
    const orphan = RunIdSchema.parse("22222222-aaaa-4bbb-8ccc-000000000e02");
    await w.runs.create(orphan, INC);
    await w.runs.setState(orphan, { status: "PHASE", phase: "AGENT_IMPLEMENT", attempt: 1 });
    await w.runs.setSessionRef(orphan, "sess-live" as SessionRef);
    await recoverOrphanedRuns(w.uow, nullLogger);
    const msg = w.outbox.rows.find((r) => r.topic === "run.resume");
    expect(msg?.payloadJson).toContain('"startPhase":"AGENT_IMPLEMENT"');
    expect(msg?.payloadJson).toContain('"attempt":1'); // resume, not redo
  });
});
