// Runtime ports — the interfaces persistence must implement. Domain depends
// on these; persistence depends on domain (one-way). All shapes come from
// contracts; nothing here knows Prisma exists.

import type {
  ContextPackManifest,
  EffectKind,
  EffectRecord,
  EffectStatus,
  IncrementId,
  IncrementState,
  IncrementStatus,
  ModelUsage,
  OutboxMessage,
  RunId,
  RunPhaseName,
  RunState,
  SessionRef,
} from "@signet/contracts";

export interface IncrementRepo {
  get(id: IncrementId): Promise<IncrementRow | null>;
  /** Transition with legality check against ALLOWED_INCREMENT_TRANSITIONS; throws conflict error on illegal move. */
  transition(id: IncrementId, from: IncrementStatus, to: IncrementState): Promise<void>;
  listByStatus(status: IncrementStatus): Promise<IncrementRow[]>;
}

export interface IncrementRow {
  id: IncrementId;
  featureId: string;
  title: string;
  state: IncrementState;
  declaredSurface: string[];
  repairAttempt: number;
  freshRestarts: number;
}

export interface RunRepo {
  create(runId: RunId, incrementId: IncrementId): Promise<void>;
  get(runId: RunId): Promise<RunRow | null>;
  setState(runId: RunId, state: RunState): Promise<void>;
  setSessionRef(runId: RunId, ref: SessionRef): Promise<void>;
  setWorkspacePath(runId: RunId, path: string): Promise<void>;
  /** Runs whose status=PHASE — candidates for orphan recovery at boot. */
  listInPhase(): Promise<RunRow[]>;
  /** Record a recovery point: phase entered. Same-transaction with effects when tx provided. */
  enterPhase(runId: RunId, phase: RunPhaseName, attempt: number): Promise<void>;
  completePhase(runId: RunId, phase: RunPhaseName, attempt: number): Promise<void>;
  recordUsage(runId: RunId, usage: ModelUsage[], costUsd?: number): Promise<void>;
  saveManifest(runId: RunId, manifest: ContextPackManifest): Promise<void>;
}

export interface RunRow {
  id: RunId;
  incrementId: IncrementId;
  state: RunState;
  workspacePath: string | null;
  sessionRef: SessionRef | null;
}

export interface EffectJournal {
  /**
   * Journal an effect (status JOURNALED) if its idempotency key is new;
   * returns the existing record when the key was seen before (crash replay).
   * MUST be called in the same transaction as the state change motivating it.
   */
  journal(input: {
    runId: RunId;
    phase: RunPhaseName;
    kind: EffectKind;
    idempotencyKey: string;
    payloadJson: string;
  }): Promise<EffectRecord>;
  markExecuting(idempotencyKey: string): Promise<void>;
  markDone(idempotencyKey: string, resultJson?: string): Promise<void>;
  markFailed(idempotencyKey: string): Promise<void>;
  byStatus(runId: RunId, status: EffectStatus): Promise<EffectRecord[]>;
}

export interface Outbox {
  /** Enqueue in the caller's transaction — the whole point of an outbox. */
  enqueue(msg: Omit<OutboxMessage, "id">): Promise<void>;
  /** Claim up to n due messages (SKIP LOCKED semantics), oldest first. */
  claimDue(n: number): Promise<OutboxMessage[]>;
  markProcessed(id: string): Promise<void>;
  /** Release a claim after a handler crash so the message redelivers. */
  release(id: string): Promise<void>;
}

export interface QuotaStore {
  recordExhausted(kind: "five_hour" | "weekly", resetsAt: Date | null): Promise<void>;
  /** Latest known state; null = never observed exhausted. */
  current(): Promise<{ kind: "five_hour" | "weekly"; exhausted: boolean; resetsAt: Date | null } | null>;
  clearExhausted(): Promise<void>;
}

/** Unit of work: run `fn` inside one DB transaction spanning repos above. */
export interface UnitOfWork {
  run<T>(fn: (tx: TxPorts) => Promise<T>): Promise<T>;
}

export interface TxPorts {
  increments: IncrementRepo;
  runs: RunRepo;
  effects: EffectJournal;
  outbox: Outbox;
}
