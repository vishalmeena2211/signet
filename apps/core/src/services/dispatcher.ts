// The dispatcher — the master's heartbeat. Polls the outbox for due messages
// (including parked resumes whose availableAt has arrived), enforces the
// worker concurrency cap, and hands runs to the RunEngine. Crash-safe by
// construction: claims are leases (5-min reclaim in the outbox), run state
// lives in recovery points, and the completer re-queues orphans at boot.

import { randomUUID } from "node:crypto";
import {
  OutboxMessageSchema,
  RunIdSchema,
  IncrementIdSchema,
  type OutboxMessage,
  type RunPhaseName,
} from "@signet/contracts";
import { z } from "zod";
import type { Logger } from "../domain/runtime/logger.js";
import type { QuotaStore, UnitOfWork } from "../domain/runtime/ports.js";
import { recoveryDecision } from "../domain/runtime/run-machine.js";
import type { RunEngine, RunOutcome } from "./run-engine.js";

const DispatchPayload = z.object({
  runId: RunIdSchema,
  incrementId: IncrementIdSchema,
  startPhase: z.enum([
    "ASSEMBLE_PACK",
    "CREATE_WORKSPACE",
    "AGENT_PLAN",
    "SCOPE_CHECK",
    "AGENT_IMPLEMENT",
    "GATES",
    "FINALIZE",
  ]),
  attempt: z.number().int().min(1),
});
export type DispatchPayloadT = z.infer<typeof DispatchPayload>;

export interface DispatcherOptions {
  maxConcurrentWorkers: number;
  pollIntervalMs: number;
}

export class Dispatcher {
  private active = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly engine: RunEngine,
    private readonly quota: QuotaStore,
    private readonly opts: DispatcherOptions,
    private readonly log: Logger,
    private readonly onOutcome: (runId: string, incrementId: string, outcome: RunOutcome) => Promise<void>,
  ) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.opts.pollIntervalMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** One poll: claim as many due messages as free worker slots allow. */
  async tick(): Promise<void> {
    if (this.stopped) return;

    // Quota gate: when the shared window is exhausted, nothing dispatches.
    const q = await this.quota.current();
    if (q?.exhausted) return;

    const free = this.opts.maxConcurrentWorkers - this.active;
    if (free <= 0) return;

    const claimed = await this.uow.run(async (tx) => tx.outbox.claimDue(free));
    for (const msg of claimed) {
      void this.handle(msg);
    }
  }

  private async handle(msg: OutboxMessage): Promise<void> {
    const valid = OutboxMessageSchema.parse(msg);
    if (valid.topic !== "run.dispatch" && valid.topic !== "run.resume") {
      // Not ours (gate.execute / notify are consumed elsewhere) — release.
      await this.uow.run(async (tx) => tx.outbox.release(valid.id));
      return;
    }
    let payloadJson: unknown;
    try {
      payloadJson = JSON.parse(valid.payloadJson); // signet-policy-allow: raw-json-parse -- validated by DispatchPayload immediately below
    } catch {
      payloadJson = null;
    }
    const parsed = DispatchPayload.safeParse(payloadJson);
    if (!parsed.success) {
      this.log.error("dispatch.bad_payload", { id: valid.id, error: parsed.error.message });
      await this.uow.run(async (tx) => tx.outbox.markProcessed(valid.id)); // poison message: park it processed, never loop
      return;
    }
    const { runId, incrementId, startPhase, attempt } = parsed.data;
    this.active += 1;
    const log = this.log.child({ runId, incrementId });
    try {
      const outcome = await this.engine.execute(runId, incrementId, startPhase, attempt);
      await this.uow.run(async (tx) => tx.outbox.markProcessed(valid.id));

      if (outcome.outcome === "parked") {
        // Re-enqueue for the reset time; the tick's quota gate keeps others out too.
        const resumeAt = outcome.resumeAt ?? new Date(Date.now() + 15 * 60_000);
        await this.quota.recordExhausted("five_hour", outcome.resumeAt);
        await this.uow.run(async (tx) =>
          tx.outbox.enqueue({
            topic: "run.resume",
            payloadJson: JSON.stringify({
              runId,
              incrementId,
              startPhase: "AGENT_IMPLEMENT",
              attempt,
            } satisfies DispatchPayloadT),
            availableAt: resumeAt.toISOString(),
          }),
        );
        log.warn("dispatch.parked", { resumeAt: resumeAt.toISOString() });
      }
      await this.onOutcome(runId, incrementId, outcome);
    } catch (e) {
      log.error("dispatch.crashed", { error: String(e) });
      await this.uow.run(async (tx) => tx.outbox.release(valid.id)).catch(() => {});
    } finally {
      this.active -= 1;
    }
  }
}

/**
 * The completer: at boot, find runs stranded mid-phase and re-enqueue them
 * from their last recovery point. Interrupted implements resume their agent
 * session; other phases re-enter with a bumped attempt.
 */
export async function recoverOrphanedRuns(uow: UnitOfWork, log: Logger): Promise<number> {
  const orphans = await uow.run(async (tx) => tx.runs.listInPhase());
  let recovered = 0;
  for (const run of orphans) {
    const decision = recoveryDecision(run.state, run.sessionRef !== null);
    if (!decision || decision.kind !== "enter_phase") continue;
    await uow.run(async (tx) =>
      tx.outbox.enqueue({
        topic: "run.resume",
        payloadJson: JSON.stringify({
          runId: run.id,
          incrementId: run.incrementId,
          startPhase: decision.phase satisfies RunPhaseName,
          attempt: decision.attempt,
        } satisfies DispatchPayloadT),
        availableAt: new Date().toISOString(),
      }),
    );
    recovered += 1;
    log.info("completer.requeued", { runId: run.id, phase: decision.phase });
  }
  return recovered;
}

/** Enqueue a fresh run for an increment (the API calls this on human approval). */
export async function enqueueRun(uow: UnitOfWork, incrementId: string): Promise<string> {
  const runId = RunIdSchema.parse(randomUUID());
  const incId = IncrementIdSchema.parse(incrementId);
  await uow.run(async (tx) => {
    await tx.runs.create(runId, incId);
    await tx.outbox.enqueue({
      topic: "run.dispatch",
      payloadJson: JSON.stringify({
        runId,
        incrementId: incId,
        startPhase: "ASSEMBLE_PACK",
        attempt: 1,
      } satisfies DispatchPayloadT),
      availableAt: new Date().toISOString(),
    });
  });
  return runId;
}
