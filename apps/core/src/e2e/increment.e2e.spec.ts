// PHASE 0 ACCEPTANCE — the full spine, live:
//   feature + frozen brief + increment rows (Postgres)
//   → enqueueRun → dispatcher → REAL Claude Code worker (haiku, capped)
//   → gates (typecheck/lint/tests incl. fail-then-pass) → AWAITING_SIGNATURE
//   → human merge simulated → run TWICE for reproducibility.
// Guarded: SIGNET_E2E=1 + live DB + logged-in CLI required.
//   SIGNET_E2E=1 SIGNET_DATABASE_URL=postgresql://signet:signet@127.0.0.1:5765/signet \
//     vitest run src/e2e/increment.e2e.spec.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { IncrementIdSchema, type IncrementId } from "@signet/contracts";
import { PrismaClient } from "../persistence/generated/client.js";
import { setupTestDatabase, truncateAll } from "../testing/test-db.js";
import { PrismaUnitOfWork, PrismaQuotaStore } from "../persistence/prisma-ports.js";
import { WorktreeManager } from "../domain/runtime/worktree-manager.js";
import { ClaudeAdapter } from "../domain/adapter/claude-adapter.js";
import { GateSuite } from "../domain/gates/gate-runner.js";
import { typecheckGate, lintGate, testsGate } from "../domain/gates/standard-gates.js";
import { makeRunOnBase } from "../domain/gates/base-overlay.js";
import { checkScope } from "../domain/pipeline/scope-checker.js";
import { RunEngine } from "../services/run-engine.js";
import { ClaudeAgentDriver } from "../services/claude-agent-driver.js";
import { PackAssemblerV0 } from "../services/pack-assembler.js";
import { Dispatcher, enqueueRun } from "../services/dispatcher.js";
import type { Logger } from "../domain/runtime/logger.js";
import type { RunOutcome } from "../services/run-engine.js";

const ctx = await setupTestDatabase();
// The e2e suites burn real quota, so they stay opt-in as well as isolated.
const enabled = process.env["SIGNET_E2E"] === "1" && ctx !== null;
const url = ctx?.url ?? "";
const d = enabled ? describe : describe.skip;

const pexec = promisify(execFile);
const log: Logger = {
  debug() {},
  info(e, c) {
    console.log("[e2e]", e, c ?? ""); // signet-policy-allow: console -- e2e observability harness
  },
  warn(e, c) {
    console.log("[e2e][warn]", e, c ?? ""); // signet-policy-allow: console -- e2e observability harness
  },
  error(e, c) {
    console.log("[e2e][err]", e, c ?? ""); // signet-policy-allow: console -- e2e observability harness
  },
  child() {
    return log;
  },
};

let client: PrismaClient;
let uow: PrismaUnitOfWork;
let repo: string;
let workspaces: string;
let packs: string;

async function git(args: string[], cwd: string) {
  await pexec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
}

/** Fixture project: greet() exists; the brief asks for shout(). */
async function makeFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "signet-e2e-repo-"));
  await git(["init", "-b", "main"], dir);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "e2e-fixture", private: true, type: "module", scripts: { test: "node run-tests.mjs" } }),
  );
  await writeFile(
    join(dir, "run-tests.mjs"),
    `import { readdir } from "node:fs/promises";
const files = (await readdir(".")).filter((f) => f.endsWith(".test.mjs"));
let failed = 0;
for (const f of files) {
  try { await import("./" + f); console.log("ok " + f); }
  catch (e) { failed++; console.error("FAIL " + f + ": " + e.message); }
}
process.exit(failed === 0 ? 0 : 1);
`,
  );
  await writeFile(join(dir, "greet.mjs"), `export const greet = (name) => "hello " + name;\n`);
  await writeFile(
    join(dir, "greet.test.mjs"),
    `import { greet } from "./greet.mjs";
if (greet("x") !== "hello x") throw new Error("greet broken");
`,
  );
  await git(["add", "-A"], dir);
  await git(["commit", "-m", "base"], dir);
  return dir;
}

async function seedIncrement(title: string, briefMd: string, acceptanceMd: string, surface: string[]): Promise<IncrementId> {
  const featureId = randomUUID();
  const briefId = randomUUID();
  const incId = randomUUID();
  await client.feature.create({ data: { id: featureId, title, stage: "IMPLEMENTING" } });
  await client.briefVersion.create({ data: { id: briefId, featureId, version: 1, contentMd: briefMd } });
  await client.increment.create({
    data: {
      id: incId,
      featureId,
      title,
      status: "CONTEXT_READY",
      stateJson: JSON.stringify({ status: "CONTEXT_READY" }),
      declaredSurface: surface,
      briefVersionId: briefId,
      orderIndex: 0,
    },
  });
  // acceptance stored inline in brief for v0 pack sources below
  acceptanceByIncrement.set(incId, acceptanceMd);
  return IncrementIdSchema.parse(incId);
}

const acceptanceByIncrement = new Map<string, string>();

function buildWorld() {
  const worktrees = new WorktreeManager(repo, workspaces);
  const adapter = new ClaudeAdapter({ binary: "claude", timeoutMs: 240_000 }, log);
  const driver = new ClaudeAgentDriver(adapter, { model: "claude-haiku-4-5", maxTurns: 25 });
  const gates = new GateSuite(
    [typecheckGate(), lintGate(), testsGate({ runOnBase: makeRunOnBase() })],
    async (runId, v) => {
      await client.gateVerdict.create({
        data: { id: randomUUID(), runId, gate: v.gate, outcome: v.outcome, findingsJson: JSON.stringify(v.findings) },
      });
    },
    log,
  );
  const packAssembler = new PackAssemblerV0(
    packs,
    {
      async loadIncrement(id) {
        const row = await client.increment.findUniqueOrThrow({ where: { id } });
        const brief = await client.briefVersion.findUniqueOrThrow({ where: { id: row.briefVersionId } });
        return {
          title: row.title,
          declaredSurface: row.declaredSurface,
          briefVersionId: row.briefVersionId,
          briefContentMd: brief.contentMd,
          acceptanceMd: acceptanceByIncrement.get(id) ?? "",
          handoffNote: null,
          designSliceMd: null,
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
          : { passed: false, repairFeedback: res.repairFeedback, error: res.error ?? { kind: "recoverable", code: "gates.failed", message: "gates" } };
      },
    },
    packAssembler,
    { check: checkScope },
    { baseRef: "main", maxRepairIterations: 3, maxFreshRestarts: 1 },
    log,
  );
  return { engine, worktrees };
}

async function runIncrementToSignature(incrementId: IncrementId): Promise<{ outcome: RunOutcome; runId: string }> {
  const { engine } = buildWorld();
  const quota = new PrismaQuotaStore(client);
  const outcomes: Array<{ runId: string; outcome: RunOutcome }> = [];
  const dispatcher = new Dispatcher(
    uow,
    engine,
    quota,
    { maxConcurrentWorkers: 2, pollIntervalMs: 500 },
    log,
    async (runId, _inc, outcome) => {
      outcomes.push({ runId, outcome });
    },
  );
  const runId = await enqueueRun(uow, incrementId);
  dispatcher.start();
  const deadline = Date.now() + 8 * 60_000;
  while (outcomes.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  await dispatcher.stop();
  const first = outcomes[0];
  if (!first) throw new Error("e2e: no outcome within deadline");
  return { outcome: first.outcome, runId };
}

beforeAll(async () => {
  if (!enabled) return;
  client = ctx!.db;
  uow = new PrismaUnitOfWork(client);
  repo = await makeFixtureRepo();
  workspaces = await mkdtemp(join(tmpdir(), "signet-e2e-ws-"));
  packs = await mkdtemp(join(tmpdir(), "signet-e2e-packs-"));
});

afterAll(async () => {
  if (!enabled) return;
  // Id-free and unconditional: a teardown that deletes remembered rows can
  // miss one, and missing one is how 22 test features ended up on the board.
  await truncateAll(client, url);
  await rm(repo, { recursive: true, force: true }).catch(() => {});
  await rm(workspaces, { recursive: true, force: true }).catch(() => {});
  await rm(packs, { recursive: true, force: true }).catch(() => {});
  await client.$disconnect();
});

d("PHASE 0 E2E (LIVE — real worker, live DB)", () => {
  it(
    "increment #1: spec → real agent → gates → succeeded, honestly telemetered",
    { timeout: 10 * 60_000 },
    async () => {
      const inc = await seedIncrement(
        "Add shout()",
        "Add a `shout(name)` function to greet.mjs returning the greeting upper-cased with an exclamation mark. Example: shout('ana') === 'HELLO ANA!'",
        "shout('ana') returns 'HELLO ANA!'; existing greet() behaviour unchanged; a new test covers shout and fails without the change.",
        ["greet.mjs", "*.test.mjs"],
      );
      const { outcome, runId } = await runIncrementToSignature(inc);
      expect(outcome).toEqual({ outcome: "succeeded" });

      // Honest telemetry: usage rows exist for the real model
      const usage = await client.usageLedgerEntry.findMany({ where: { runId } });
      expect(usage.length).toBeGreaterThan(0);
      // Verdicts persisted for every gate
      const verdicts = await client.gateVerdict.findMany({ where: { runId } });
      expect(verdicts.map((v) => v.gate).sort()).toEqual(["lint", "tests", "typecheck"]);
      // Manifest answers "what did it know"
      const manifest = await client.contextPackManifest.findUnique({ where: { runId } });
      expect(manifest).toBeTruthy();

      // Human signature #2 simulated: merge the worktree branch
      await git(["merge", "--no-ff", "-m", "merge inc1", `signet/inc-${inc}`], repo);
      const { stdout } = await pexec("node", ["-e", `import('${join(repo, "greet.mjs")}').then(m => console.log(m.shout('ana')))`]);
      expect(stdout.trim()).toBe("HELLO ANA!");
    },
  );

  it(
    "increment #2 on the merged base: reproducible second pass",
    { timeout: 10 * 60_000 },
    async () => {
      const inc = await seedIncrement(
        "Add whisper()",
        "Add a `whisper(name)` function to greet.mjs returning the greeting lower-cased with an ellipsis. Example: whisper('ANA') === 'hello ana...'",
        "whisper('ANA') returns 'hello ana...'; existing functions unchanged; a new failing-first test covers whisper.",
        ["greet.mjs", "*.test.mjs"],
      );
      const { outcome } = await runIncrementToSignature(inc);
      expect(outcome).toEqual({ outcome: "succeeded" });
      await git(["merge", "--no-ff", "-m", "merge inc2", `signet/inc-${inc}`], repo);
      const { stdout } = await pexec("node", ["-e", `import('${join(repo, "greet.mjs")}').then(m => console.log(m.whisper('ANA')))`]);
      expect(stdout.trim()).toBe("hello ana...");
    },
  );
});
