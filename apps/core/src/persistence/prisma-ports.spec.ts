// Live integration tests against the embedded dev Postgres. Run with:
//   SIGNET_DATABASE_URL=postgresql://signet:signet@127.0.0.1:5765/signet vitest run
// Skips (loudly) when the DB is unreachable so unit runs stay green offline.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  IncrementIdSchema,
  RunIdSchema,
  type IncrementId,
  type RunId,
} from "@signet/contracts";
import { PrismaClient } from "./generated/client.js";
import { setupTestDatabase, truncateAll } from "../testing/test-db.js";
import { PrismaUnitOfWork } from "./prisma-ports.js";

const ctx = await setupTestDatabase();
const enabled = ctx !== null;
const url = ctx?.url ?? "";

const d = enabled ? describe : describe.skip;

let client: PrismaClient;
let uow: PrismaUnitOfWork;
let FEATURE: string;
let INC: IncrementId;
let RUN: RunId;

beforeAll(async () => {
  if (!enabled) return;
  client = ctx!.db;
  uow = new PrismaUnitOfWork(client);
  FEATURE = randomUUID();
  INC = IncrementIdSchema.parse(randomUUID());
  RUN = RunIdSchema.parse(randomUUID());
  await client.feature.create({ data: { id: FEATURE, title: "itest feature", stage: "IMPLEMENTING" } });
  await client.briefVersion.create({
    data: { id: randomUUID(), featureId: FEATURE, version: 1, contentMd: "# brief" },
  });
  await client.increment.create({
    data: {
      id: INC,
      featureId: FEATURE,
      title: "itest increment",
      status: "PLANNED",
      stateJson: JSON.stringify({ status: "PLANNED" }),
      declaredSurface: ["src/**"],
      briefVersionId: (await client.briefVersion.findFirstOrThrow({ where: { featureId: FEATURE } })).id,
      orderIndex: 0,
    },
  });
});

afterAll(async () => {
  if (!enabled) return;
  // Id-free and unconditional: a teardown that deletes remembered rows can
  // miss one, and missing one is how 22 test features ended up on the board.
  await truncateAll(client, url);
  await client.$disconnect();
});

d("prisma ports (live embedded postgres)", () => {
  it("run lifecycle: create → phases as recovery points → succeed", async () => {
    await uow.run(async (tx) => {
      await tx.runs.create(RUN, INC);
      await tx.runs.enterPhase(RUN, "ASSEMBLE_PACK", 1);
      await tx.runs.completePhase(RUN, "ASSEMBLE_PACK", 1);
      await tx.runs.setState(RUN, { status: "PHASE", phase: "CREATE_WORKSPACE", attempt: 1 });
    });
    const inPhase = await uow.run(async (tx) => tx.runs.listInPhase());
    expect(inPhase.some((r) => r.id === RUN)).toBe(true);
    await uow.run(async (tx) => {
      await tx.runs.setState(RUN, { status: "SUCCEEDED" });
    });
    const after = await uow.run(async (tx) => tx.runs.get(RUN));
    expect(after?.state).toEqual({ status: "SUCCEEDED" });
  });

  it("increment transitions enforce legality and optimistic concurrency", async () => {
    await uow.run(async (tx) => {
      await tx.increments.transition(INC, "PLANNED", { status: "CONTEXT_READY" });
    });
    // Illegal jump CONTEXT_READY -> MERGED must throw
    await expect(
      uow.run(async (tx) => {
        await tx.increments.transition(INC, "CONTEXT_READY", {
          status: "MERGED",
          mergedAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow(/illegal increment transition/);
    // Stale `from` must throw the concurrency error
    await expect(
      uow.run(async (tx) => {
        await tx.increments.transition(INC, "PLANNED", { status: "CONTEXT_READY" });
      }),
    ).rejects.toThrow(/moved concurrently|illegal/);
  });

  it("effect journal: same idempotency key returns the original record (replay-safe)", async () => {
    const key = `itest:${RUN}:pr_open:1`;
    const first = await uow.run(async (tx) =>
      tx.effects.journal({ runId: RUN, phase: "FINALIZE", kind: "pr_open", idempotencyKey: key, payloadJson: "{}" }),
    );
    await uow.run(async (tx) => tx.effects.markDone(key, '{"pr":42}'));
    const replay = await uow.run(async (tx) =>
      tx.effects.journal({ runId: RUN, phase: "FINALIZE", kind: "pr_open", idempotencyKey: key, payloadJson: "{}" }),
    );
    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe("DONE"); // the crashed retry sees it already happened
    expect(replay.resultJson).toBe('{"pr":42}');
  });

  it("outbox: enqueue in-tx, claim once under concurrency, future messages stay hidden", async () => {
    const topicPayload = `itest-${randomUUID()}`;
    const futureMarker = `future-${randomUUID()}`;
    await uow.run(async (tx) => {
      await tx.outbox.enqueue({
        topic: "run.dispatch",
        payloadJson: topicPayload,
        availableAt: new Date().toISOString(),
      });
      await tx.outbox.enqueue({
        topic: "run.resume",
        payloadJson: futureMarker,
        availableAt: new Date(Date.now() + 3600_000).toISOString(), // parked 1h
      });
    });
    // Two concurrent claimers must not double-claim (SKIP LOCKED)
    const [a, b] = await Promise.all([
      uow.run(async (tx) => tx.outbox.claimDue(10)),
      uow.run(async (tx) => tx.outbox.claimDue(10)),
    ]);
    const mine = [...a, ...b].filter((m) => m.payloadJson === topicPayload);
    expect(mine).toHaveLength(1);
    const future = [...a, ...b].filter((m) => m.payloadJson === futureMarker);
    expect(future).toHaveLength(0);
    const claimed = mine[0];
    if (claimed) await uow.run(async (tx) => tx.outbox.markProcessed(claimed.id));
  });

  it("usage ledger records per-model rows", async () => {
    await uow.run(async (tx) =>
      tx.runs.recordUsage(
        RUN,
        [
          { model: "claude-opus-5", inputTokens: 1000, cachedInputTokens: 500, outputTokens: 400 },
          { model: "claude-haiku-4-5", inputTokens: 50, cachedInputTokens: 0, outputTokens: 20 },
        ],
        0.5,
      ),
    );
    const rows = await client.usageLedgerEntry.findMany({ where: { runId: RUN } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
