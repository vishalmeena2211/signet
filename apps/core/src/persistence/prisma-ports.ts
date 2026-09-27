// Prisma implementations of the runtime ports. Rows are parsed through
// contracts schemas at this boundary — the DB stores, contracts decide.
// UnitOfWork maps to a single interactive transaction; every port method
// called inside uow.run() shares that transaction.

import { randomUUID } from "node:crypto";
import {
  ALLOWED_INCREMENT_TRANSITIONS,
  ContextPackManifestSchema,
  EffectRecordSchema,
  IncrementIdSchema,
  IncrementStateSchema,
  RunIdSchema,
  RunStateSchema,
  SessionRefSchema,
  conflict,
  type ContextPackManifest,
  type EffectRecord,
  type EffectStatus,
  type IncrementId,
  type IncrementState,
  type IncrementStatus,
  type ModelUsage,
  type OutboxMessage,
  type RunId,
  type RunPhaseName,
  type RunState,
  type SessionRef,
} from "@signet/contracts";
import type {
  EffectJournal,
  IncrementRepo,
  IncrementRow,
  Outbox,
  QuotaStore,
  RunRepo,
  RunRow,
  TxPorts,
  UnitOfWork,
} from "../domain/runtime/ports.js";
import type { PrismaClient, Prisma } from "./generated/client.js";

type Tx = Prisma.TransactionClient;

// ── increments ───────────────────────────────────────────────────────────────

class PrismaIncrements implements IncrementRepo {
  constructor(private readonly db: Tx) {}

  async get(id: IncrementId): Promise<IncrementRow | null> {
    const row = await this.db.increment.findUnique({ where: { id } });
    if (!row) return null;
    return {
      id: IncrementIdSchema.parse(row.id),
      featureId: row.featureId,
      title: row.title,
      state: IncrementStateSchema.parse(JSON.parse(row.stateJson)), // signet-policy-allow: raw-json-parse -- immediately schema-validated on this line
      declaredSurface: row.declaredSurface,
      repairAttempt: row.repairAttempt,
      freshRestarts: row.freshRestarts,
    };
  }

  async transition(id: IncrementId, from: IncrementStatus, to: IncrementState): Promise<void> {
    if (from !== to.status) {
      const allowed = ALLOWED_INCREMENT_TRANSITIONS[from];
      if (!allowed.includes(to.status)) {
        throw Object.assign(new Error(`illegal increment transition ${from} -> ${to.status}`), {
          signet: conflict("increment.illegal_transition", `${from} -> ${to.status}`),
        });
      }
    }
    // Optimistic concurrency: status must still equal `from` when we write.
    const result = await this.db.increment.updateMany({
      where: { id, status: from },
      data: { status: to.status, stateJson: JSON.stringify(to) },
    });
    if (result.count === 0) {
      throw Object.assign(new Error(`increment ${id} moved concurrently (expected ${from})`), {
        signet: conflict("increment.concurrent_transition", `expected status ${from}`),
      });
    }
  }

  async listByStatus(status: IncrementStatus): Promise<IncrementRow[]> {
    const rows = await this.db.increment.findMany({ where: { status }, orderBy: { orderIndex: "asc" } });
    return rows.map((row) => ({
      id: IncrementIdSchema.parse(row.id),
      featureId: row.featureId,
      title: row.title,
      state: IncrementStateSchema.parse(JSON.parse(row.stateJson)), // signet-policy-allow: raw-json-parse -- immediately schema-validated on this line
      declaredSurface: row.declaredSurface,
      repairAttempt: row.repairAttempt,
      freshRestarts: row.freshRestarts,
    }));
  }

  async setBudget(
    id: IncrementId,
    budget: { repairAttempt?: number; freshRestarts?: number },
  ): Promise<void> {
    await this.db.increment.update({
      where: { id },
      data: {
        ...(budget.repairAttempt !== undefined ? { repairAttempt: budget.repairAttempt } : {}),
        ...(budget.freshRestarts !== undefined ? { freshRestarts: budget.freshRestarts } : {}),
      },
    });
  }
}

// ── runs ─────────────────────────────────────────────────────────────────────

class PrismaRuns implements RunRepo {
  constructor(private readonly db: Tx) {}

  async create(runId: RunId, incrementId: IncrementId): Promise<void> {
    const state: RunState = { status: "CREATED" };
    await this.db.run.create({
      data: { id: runId, incrementId, status: state.status, stateJson: JSON.stringify(state) },
    });
  }

  async get(runId: RunId): Promise<RunRow | null> {
    const row = await this.db.run.findUnique({ where: { id: runId } });
    if (!row) return null;
    return {
      id: RunIdSchema.parse(row.id),
      incrementId: IncrementIdSchema.parse(row.incrementId),
      state: RunStateSchema.parse(JSON.parse(row.stateJson)), // signet-policy-allow: raw-json-parse -- immediately schema-validated on this line
      workspacePath: row.workspacePath,
      sessionRef: row.sessionRef ? SessionRefSchema.parse(row.sessionRef) : null,
    };
  }

  async setState(runId: RunId, state: RunState): Promise<void> {
    await this.db.run.update({
      where: { id: runId },
      data: {
        status: state.status,
        stateJson: JSON.stringify(state),
        ...(state.status === "SUCCEEDED" || state.status === "FAILED" || state.status === "ABORTED"
          ? { finishedAt: new Date() }
          : {}),
      },
    });
  }

  async setSessionRef(runId: RunId, ref: SessionRef): Promise<void> {
    await this.db.run.update({ where: { id: runId }, data: { sessionRef: ref } });
  }

  async setWorkspacePath(runId: RunId, path: string): Promise<void> {
    await this.db.run.update({ where: { id: runId }, data: { workspacePath: path } });
  }

  async listInPhase(): Promise<RunRow[]> {
    const rows = await this.db.run.findMany({ where: { status: "PHASE" } });
    return rows.map((row) => ({
      id: RunIdSchema.parse(row.id),
      incrementId: IncrementIdSchema.parse(row.incrementId),
      state: RunStateSchema.parse(JSON.parse(row.stateJson)), // signet-policy-allow: raw-json-parse -- immediately schema-validated on this line
      workspacePath: row.workspacePath,
      sessionRef: row.sessionRef ? SessionRefSchema.parse(row.sessionRef) : null,
    }));
  }

  async enterPhase(runId: RunId, phase: RunPhaseName, attempt: number): Promise<void> {
    await this.db.runPhase.upsert({
      where: { runId_phase_attempt: { runId, phase, attempt } },
      create: { id: randomUUID(), runId, phase, attempt },
      update: {}, // recovery re-enter is a no-op on the recovery point row
    });
  }

  async completePhase(runId: RunId, phase: RunPhaseName, attempt: number): Promise<void> {
    await this.db.runPhase.update({
      where: { runId_phase_attempt: { runId, phase, attempt } },
      data: { completedAt: new Date() },
    });
  }

  async recordUsage(runId: RunId, usage: ModelUsage[], costUsd?: number): Promise<void> {
    if (usage.length === 0) return;
    const perEntryCost = costUsd !== undefined ? costUsd / usage.length : undefined;
    await this.db.usageLedgerEntry.createMany({
      data: usage.map((u) => ({
        id: randomUUID(),
        runId,
        model: u.model,
        inputTokens: u.inputTokens,
        cachedInputTokens: u.cachedInputTokens,
        outputTokens: u.outputTokens,
        ...(perEntryCost !== undefined ? { costUsd: perEntryCost } : {}),
      })),
    });
  }

  async saveManifest(runId: RunId, manifest: ContextPackManifest): Promise<void> {
    const valid = ContextPackManifestSchema.parse(manifest);
    await this.db.contextPackManifest.upsert({
      where: { runId },
      create: { id: randomUUID(), runId, manifestJson: JSON.stringify(valid), packHash: valid.packHash },
      update: { manifestJson: JSON.stringify(valid), packHash: valid.packHash },
    });
  }
}

// ── effect journal ───────────────────────────────────────────────────────────

class PrismaEffects implements EffectJournal {
  constructor(private readonly db: Tx) {}

  async journal(input: {
    runId: RunId;
    phase: RunPhaseName;
    kind: EffectRecord["kind"];
    idempotencyKey: string;
    payloadJson: string;
  }): Promise<EffectRecord> {
    const existing = await this.db.effect.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      return EffectRecordSchema.parse({
        id: existing.id,
        runId: existing.runId,
        phase: existing.phase,
        kind: existing.kind,
        idempotencyKey: existing.idempotencyKey,
        status: existing.status,
        payloadJson: existing.payloadJson,
        ...(existing.resultJson !== null ? { resultJson: existing.resultJson } : {}),
        attempt: existing.attempt,
      });
    }
    const created = await this.db.effect.create({
      data: {
        id: randomUUID(),
        runId: input.runId,
        phase: input.phase,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        status: "JOURNALED",
        payloadJson: input.payloadJson,
      },
    });
    return EffectRecordSchema.parse({
      id: created.id,
      runId: created.runId,
      phase: created.phase,
      kind: created.kind,
      idempotencyKey: created.idempotencyKey,
      status: created.status,
      payloadJson: created.payloadJson,
      attempt: created.attempt,
    });
  }

  async markExecuting(key: string): Promise<void> {
    await this.db.effect.update({
      where: { idempotencyKey: key },
      data: { status: "EXECUTING", attempt: { increment: 1 } },
    });
  }
  async markDone(key: string, resultJson?: string): Promise<void> {
    await this.db.effect.update({
      where: { idempotencyKey: key },
      data: { status: "DONE", ...(resultJson !== undefined ? { resultJson } : {}) },
    });
  }
  async markFailed(key: string): Promise<void> {
    await this.db.effect.update({ where: { idempotencyKey: key }, data: { status: "FAILED" } });
  }
  async byStatus(runId: RunId, status: EffectStatus): Promise<EffectRecord[]> {
    const rows = await this.db.effect.findMany({ where: { runId, status } });
    return rows.map((r) =>
      EffectRecordSchema.parse({
        id: r.id,
        runId: r.runId,
        phase: r.phase,
        kind: r.kind,
        idempotencyKey: r.idempotencyKey,
        status: r.status,
        payloadJson: r.payloadJson,
        ...(r.resultJson !== null ? { resultJson: r.resultJson } : {}),
        attempt: r.attempt,
      }),
    );
  }
}

// ── outbox ───────────────────────────────────────────────────────────────────

class PrismaOutbox implements Outbox {
  constructor(private readonly db: Tx) {}

  async enqueue(msg: Omit<OutboxMessage, "id">): Promise<void> {
    // Raw insert with an ISO-string ::timestamptz cast: the adapter's Date
    // serialization reinterprets naive strings in the session timezone, which
    // shifted instants by the UTC offset (found by live test on a +05:30 box).
    // An ISO string with 'Z' is unambiguous server-side.
    await this.db.$executeRaw`
      INSERT INTO outbox (id, topic, payload_json, available_at)
      VALUES (${randomUUID()}::uuid, ${msg.topic}, ${msg.payloadJson}, ${msg.availableAt}::timestamptz)`;
  }

  async claimDue(n: number): Promise<OutboxMessage[]> {
    // FOR UPDATE SKIP LOCKED via raw query — the one place Prisma's query API
    // can't express the dispatch pattern.
    const rows = await this.db.$queryRaw<
      Array<{ id: string; topic: string; payload_json: string; available_at: Date }>
    >`
      UPDATE outbox SET claimed_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox
        WHERE processed_at IS NULL AND available_at <= now()
          AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
        ORDER BY available_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${n}
      )
      RETURNING id, topic, payload_json, available_at`;
    return rows.map((r) => ({
      id: r.id,
      topic: r.topic as OutboxMessage["topic"],
      payloadJson: r.payload_json,
      availableAt: r.available_at.toISOString(),
    }));
  }

  async markProcessed(id: string): Promise<void> {
    await this.db.outboxMessage.update({ where: { id }, data: { processedAt: new Date() } });
  }

  async release(id: string): Promise<void> {
    await this.db.outboxMessage.update({ where: { id }, data: { claimedAt: null } });
  }
}

// ── quota ────────────────────────────────────────────────────────────────────

export class PrismaQuotaStore implements QuotaStore {
  constructor(private readonly client: PrismaClient) {}

  async recordExhausted(kind: "five_hour" | "weekly", resetsAt: Date | null): Promise<void> {
    await this.client.quotaWindow.create({
      data: { id: randomUUID(), kind, exhaustedAt: new Date(), resetsAt },
    });
  }

  async current(): Promise<{ kind: "five_hour" | "weekly"; exhausted: boolean; resetsAt: Date | null } | null> {
    const latest = await this.client.quotaWindow.findFirst({ orderBy: { observedAt: "desc" } });
    if (!latest || latest.exhaustedAt === null) return null;
    const stillExhausted = latest.resetsAt === null || latest.resetsAt.getTime() > Date.now();
    return {
      kind: latest.kind as "five_hour" | "weekly",
      exhausted: stillExhausted,
      resetsAt: latest.resetsAt,
    };
  }

  async clearExhausted(): Promise<void> {
    await this.client.quotaWindow.create({ data: { id: randomUUID(), kind: "five_hour" } });
  }
}

// ── unit of work ─────────────────────────────────────────────────────────────

export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly client: PrismaClient) {}

  async run<T>(fn: (tx: TxPorts) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => {
      const ports: TxPorts = {
        increments: new PrismaIncrements(tx),
        runs: new PrismaRuns(tx),
        effects: new PrismaEffects(tx),
        outbox: new PrismaOutbox(tx),
      };
      return fn(ports);
    });
  }
}
