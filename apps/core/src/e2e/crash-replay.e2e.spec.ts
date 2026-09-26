// CRASH/REPLAY ACCEPTANCE — the constitution's crash-safety, against live PG:
//   a run dies mid-phase (state left as PHASE in the DB, exactly what a
//   SIGKILL leaves behind) → boot-time completer finds the orphan → re-queues
//   from the recovery point → dispatcher resumes → run completes — and
//   journaled effects with the same idempotency key DO NOT double.
// No real agent needed: a scripted driver stands in (zero quota burn).
//   SIGNET_DATABASE_URL=... vitest run src/e2e/crash-replay.e2e.spec.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  IncrementIdSchema,
  RunIdSchema,
  SessionRefSchema,
  type IncrementId,
} from "@signet/contracts";
import { PrismaClient } from "../persistence/generated/client.js";
import { setupTestDatabase, truncateAll } from "../testing/test-db.js";
import { PrismaQuotaStore, PrismaUnitOfWork } from "../persistence/prisma-ports.js";
import { WorktreeManager } from "../domain/runtime/worktree-manager.js";
import { checkScope } from "../domain/pipeline/scope-checker.js";
import { RunEngine, type AgentDriver, type RunOutcome } from "../services/run-engine.js";
import { Dispatcher, enqueueRun, recoverOrphanedRuns } from "../services/dispatcher.js";
import { PackAssemblerV0 } from "../services/pack-assembler.js";
import type { Logger } from "../domain/runtime/logger.js";

const ctx = await setupTestDatabase("crash");
const enabled = ctx !== null;
const url = ctx?.url ?? "";
const d = enabled ? describe : describe.skip;
const pexec = promisify(execFile);

const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};

let client: PrismaClient;
let uow: PrismaUnitOfWork;
let repo: string;
let workspaces: string;
let packs: string;
let INC: IncrementId;

async function git(args: string[], cwd: string) {
  await pexec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
}

beforeAll(async () => {
  if (!enabled) return;
  client = ctx!.db;
  uow = new PrismaUnitOfWork(client);
  repo = await mkdtemp(join(tmpdir(), "signet-crash-repo-"));
  workspaces = await mkdtemp(join(tmpdir(), "signet-crash-ws-"));
  packs = await mkdtemp(join(tmpdir(), "signet-crash-packs-"));
  await git(["init", "-b", "main"], repo);
  await writeFile(join(repo, "a.txt"), "base\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "base"], repo);

  const featureId = randomUUID();
  const briefId = randomUUID();
  const incId = randomUUID();
  await client.feature.create({ data: { id: featureId, title: "crash test", stage: "IMPLEMENTING" } });
  await client.briefVersion.create({ data: { id: briefId, featureId, version: 1, contentMd: "brief" } });
  await client.increment.create({
    data: {
      id: incId,
      featureId,
      title: "crash increment",
      status: "CONTEXT_READY",
      stateJson: JSON.stringify({ status: "CONTEXT_READY" }),
      declaredSurface: ["a.txt", "b.txt"],
      briefVersionId: briefId,
      orderIndex: 0,
    },
  });
  INC = IncrementIdSchema.parse(incId);
});

afterAll(async () => {
  if (!enabled) return;
  // Id-free and unconditional: a teardown that deletes remembered rows can
  // miss one, and missing one is how 22 test features ended up on the board.
  await truncateAll(client, url);
  for (const p of [repo, workspaces, packs]) await rm(p, { recursive: true, force: true }).catch(() => {});
  await client.$disconnect();
});

function buildEngine(driver: AgentDriver) {
  const packAssembler = new PackAssemblerV0(
    packs,
    {
      async loadIncrement(id) {
        const row = await client.increment.findUniqueOrThrow({ where: { id } });
        return {
          title: row.title,
          declaredSurface: row.declaredSurface,
          briefVersionId: row.briefVersionId,
          briefContentMd: "brief",
          acceptanceMd: "acceptance",
          handoffNote: null,
          designSliceMd: null,
        };
      },
    },
    uow,
  );
  return new RunEngine(
    uow,
    new WorktreeManager(repo, workspaces),
    driver,
    {
      async runAll(input) {
        // journal an idempotency-keyed effect during GATES — the double-check target
        await uow.run(async (tx) => {
          const rec = await tx.effects.journal({
            runId: input.runId,
            phase: "GATES",
            kind: "notification_send",
            idempotencyKey: `${input.runId}:GATES:notify`,
            payloadJson: "{}",
          });
          if (rec.status === "JOURNALED") await tx.effects.markDone(rec.idempotencyKey);
        });
        return { passed: true };
      },
    },
    packAssembler,
    { check: checkScope },
    { baseRef: "main", maxRepairIterations: 3, maxFreshRestarts: 1 },
    nullLogger,
  );
}

const SESSION = SessionRefSchema.parse("sess-crash-1");

function scriptedDriver(behavior: { implementShouldCrash: () => boolean; implementCount: () => void }): AgentDriver {
  return {
    async plan() {
      return {
        ok: true,
        plan: { approach: "write b.txt", filesToTouch: ["b.txt"], risks: [] },
        sessionRef: SESSION,
        usage: [{ model: "scripted", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }],
      };
    },
    async implement({ workspacePath, resumeSession, onEvent }) {
      behavior.implementCount();
      if (behavior.implementShouldCrash()) {
        // Simulate SIGKILL: die with state already persisted as PHASE — no
        // cleanup, no error handling, exactly what a dead process leaves.
        throw Object.assign(new Error("SIMULATED PROCESS DEATH"), { simulatedCrash: true });
      }
      // On resume, the session must have survived.
      if (resumeSession !== SESSION) throw new Error("resume lost the session ref");
      await writeFile(join(workspacePath, "b.txt"), "made it\n");
      await onEvent({ type: "session_started", sessionRef: SESSION });
      return { ok: true, sessionRef: SESSION };
    },
  };
}

d("crash/replay (live DB, scripted driver)", () => {
  it(
    "mid-implement death → completer requeues → resume completes; effects never double",
    { timeout: 120_000 },
    async () => {
      let implementCalls = 0;
      let crashNext = true;
      const driver = scriptedDriver({
        implementShouldCrash: () => {
          const c = crashNext;
          crashNext = false;
          return c;
        },
        implementCount: () => {
          implementCalls += 1;
        },
      });
      const engine = buildEngine(driver);
      const quota = new PrismaQuotaStore(client);
      const outcomes: RunOutcome[] = [];
      const dispatcher = new Dispatcher(
        uow,
        engine,
        quota,
        { maxConcurrentWorkers: 1, pollIntervalMs: 300 },
        nullLogger,
        async (_r, _i, o) => {
          outcomes.push(o);
        },
      );

      const runId = await enqueueRun(uow, INC);

      // Phase A: run until the simulated death. The engine's crash bubbles to
      // the dispatcher, which releases the claim; the run row stays in PHASE —
      // the exact on-disk state a SIGKILL leaves.
      dispatcher.start();
      const deadlineA = Date.now() + 30_000;
      while (implementCalls === 0 && Date.now() < deadlineA) await new Promise((r) => setTimeout(r, 200));
      await dispatcher.stop();
      // let the in-flight handler settle
      await new Promise((r) => setTimeout(r, 500));

      const torn = await uow.run(async (tx) => tx.runs.get(RunIdSchema.parse(runId)));
      expect(torn?.state.status).toBe("PHASE");
      if (torn?.state.status !== "PHASE") return;
      expect(torn.state.phase).toBe("AGENT_IMPLEMENT");
      expect(torn.sessionRef).toBe(SESSION); // recovery has a session to resume

      // The original dispatch message: mark it processed to model "the old
      // process consumed it before dying" (worst case for recovery).
      await client.outboxMessage.updateMany({
        where: { processedAt: null },
        data: { processedAt: new Date() },
      });

      // Phase B: boot recovery — completer finds the orphan, requeues at the
      // SAME attempt (session resume), dispatcher completes it.
      const recovered = await recoverOrphanedRuns(uow, nullLogger);
      expect(recovered).toBe(1);
      dispatcher.start();
      const deadlineB = Date.now() + 60_000;
      while (outcomes.length === 0 && Date.now() < deadlineB) await new Promise((r) => setTimeout(r, 300));
      await dispatcher.stop();

      expect(outcomes[0]).toEqual({ outcome: "succeeded" });
      expect(implementCalls).toBe(2); // crash + resume, no more

      // Zero doubled effects: the GATES notify effect exists exactly once, DONE.
      const effects = await client.effect.findMany({
        where: { idempotencyKey: `${runId}:GATES:notify` },
      });
      expect(effects).toHaveLength(1);
      expect(effects[0]?.status).toBe("DONE");

      // Recovery points tell the story: implement entered twice (attempt bump
      // suppressed by session resume → same attempt upserted once) and every
      // other phase exactly once.
      const phases = await client.runPhase.findMany({ where: { runId }, orderBy: { enteredAt: "asc" } });
      const names = phases.map((p) => p.phase);
      expect(names.filter((n) => n === "GATES")).toHaveLength(1);
      expect(names.filter((n) => n === "FINALIZE")).toHaveLength(1);
    },
  );
});
