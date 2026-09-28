// Read models for the three places and a feature's thread. Each method returns what one
// screen draws, already joined, so the console does no assembly of its own.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, userInfo } from "node:os";
import {
  CanalViewSchema,
  CheckoutViewSchema,
  StepSheetSchema,
  type CheckoutView,
  type StepSheet,
  DeskViewSchema,
  LedgerViewSchema,
  ThreadViewSchema,
  RUN_PHASE_ORDER,
  nonRecoverable,
  type CanalView,
  type DeskView,
  type Identity,
  type LedgerView,
  type ThreadView,
} from "@signet/contracts";
import type { z } from "zod";
import type { PrismaClient } from "../persistence/generated/client.js";
import type { DiffReader } from "./diff-reader.js";
import type { WorkViews } from "./work-views.js";
import type { AgentWorkLog } from "./agent-work.js";
import type { ProposalsInFlight } from "./feature-events.js";
import { plainQuestion } from "../domain/runtime/run-machine.js";

const pexec = promisify(execFile);

/** Loose reads of JSON we wrote ourselves; every field optional. */
function readJson(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw); // signet-policy-allow: raw-json-parse -- our own stored JSON, read field by field with type checks below
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function money(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** What each step's line says under its title in the thread. */
const SAID: Record<string, string> = {
  MERGED: "sealed",
  AWAITING_SIGNATURE: "waiting for your seal",
  CONTEXT_READY: "needs your initials",
  RUNNING: "building",
  VERIFYING: "checking",
  ESCALATED: "asked you a question",
  PARKED: "waiting for your Claude quota",
  FAILED: "failed",
  PLANNED: "not started",
};
const YOURS = new Set(["AWAITING_SIGNATURE", "CONTEXT_READY", "ESCALATED", "FAILED"]);

let identityCache: Identity | null = null;

/** The person at this machine, from their git identity — whose seal it is. */
export async function identity(): Promise<Identity> {
  if (identityCache) return identityCache;
  let name = "";
  try {
    const { stdout } = await pexec("git", ["config", "--global", "user.name"], { cwd: homedir() });
    name = stdout.trim();
  } catch {
    name = "";
  }
  if (!name) name = userInfo().username;
  const words = name.split(/\s+/).filter(Boolean);
  const first = words[0] ?? name;
  const last = words.length > 1 ? words[words.length - 1] : "";
  identityCache = {
    signature: last ? `${first[0]?.toUpperCase() ?? ""}. ${last}` : first,
    initials: ((first[0] ?? "") + (last ? (last[0] ?? "") : (first[1] ?? ""))).toUpperCase(),
  };
  return identityCache;
}

export interface PlaceDeps {
  db: PrismaClient;
  diffs: DiffReader;
  work: WorkViews;
  log: AgentWorkLog;
  proposals: ProposalsInFlight;
  quota: () => Promise<{ exhausted: boolean; resetsAt?: string | undefined; windowKind: string }>;
  configuredRepoLabel: string;
  configuredRepoPath: string;
  baseRef: string;
}

export class PlaceViews {
  constructor(private readonly d: PlaceDeps) {}

  // ── the Desk ──

  async desk(): Promise<DeskView> {
    const { db } = this.d;
    const rows = await db.increment.findMany({
      where: { status: { in: ["CONTEXT_READY", "AWAITING_SIGNATURE", "ESCALATED", "FAILED"] } },
      include: { feature: { select: { id: true, title: true } } },
      orderBy: { updatedAt: "asc" },
      take: 50,
    });
    const siblings = await db.increment.findMany({
      where: { featureId: { in: [...new Set(rows.map((r) => r.featureId))] } },
      select: { id: true, featureId: true, orderIndex: true },
    });
    const escalations = await db.escalation.findMany({
      where: { incrementId: { in: rows.map((r) => r.id) }, status: "RAISED" },
      orderBy: { createdAt: "desc" },
    });

    const decisions = await Promise.all(
      rows.map(async (r) => {
        const peers = siblings.filter((s) => s.featureId === r.featureId).sort((a, b) => a.orderIndex - b.orderIndex);
        const esc = escalations.find((e) => e.incrementId === r.id);
        const kind =
          r.status === "AWAITING_SIGNATURE" ? "seal" : r.status === "CONTEXT_READY" ? "initial" : r.status === "ESCALATED" ? "question" : "failed";
        let files: number | null = null;
        let added: number | null = null;
        let removed: number | null = null;
        let proven: number | null = null;
        let promises: number | null = null;
        if (kind === "seal") {
          const diff = await this.d.diffs.read(r.id);
          if (diff.available) {
            files = diff.files.length;
            added = diff.files.reduce((n, f) => n + f.added, 0);
            removed = diff.files.reduce((n, f) => n + f.removed, 0);
          }
          const view = await this.d.work.promises(r.id);
          if (view.checked) {
            promises = view.promises.length;
            proven = view.promises.filter((p) => p.proven).length;
          }
        }
        const spent = await db.usageLedgerEntry.aggregate({ where: { run: { incrementId: r.id } }, _sum: { costUsd: true } });
        const text =
          kind === "question"
            ? plainQuestion(str(readJson(esc?.stateJson ?? "{}")["question"]) ?? "A question was raised.")
            : kind === "failed"
              ? (str(readJson(r.stateJson)["reason"]) ?? "The run failed.")
              : null;
        return {
          kind,
          featureId: r.feature.id,
          featureTitle: r.feature.title,
          incrementId: r.id,
          stepTitle: r.title,
          stepIndex: peers.findIndex((p) => p.id === r.id) + 1,
          stepCount: peers.length,
          since: (esc?.createdAt ?? r.updatedAt).toISOString(),
          files,
          added,
          removed,
          proven,
          promises,
          repairs: r.repairAttempt,
          spentUsd: money(spent._sum.costUsd),
          surface: r.declaredSurface,
          text,
        };
      }),
    );

    const lastMerged = await this.mergedSince(new Date(0), 1);
    return DeskViewSchema.parse({
      identity: await identity(),
      repoLabel: this.d.configuredRepoLabel,
      status: await this.statusLine(),
      flow: await this.flowCounts(),
      decisions,
      lastLandedAt: lastMerged[0]?.mergedAt.toISOString() ?? null,
    });
  }

  async statusLine(): Promise<z.input<typeof DeskViewSchema>["status"]> {
    const { db } = this.d;
    const [building, spent, quota, queued] = await Promise.all([
      db.increment.count({ where: { status: { in: ["RUNNING", "VERIFYING"] } } }),
      db.usageLedgerEntry.aggregate({ where: { recordedAt: { gte: startOfToday() } }, _sum: { costUsd: true }, _count: true }),
      this.d.quota(),
      db.outboxMessage.count({ where: { processedAt: null, topic: { in: ["run.dispatch", "run.resume"] } } }),
    ]);
    const resetsAt = quota.resetsAt ?? null;
    return {
      building,
      spentTodayUsd: spent._count === 0 ? 0 : money(spent._sum.costUsd),
      held: quota.exhausted
        ? {
            resetsAt,
            windowStart: resetsAt && quota.windowKind === "five_hour" ? new Date(Date.parse(resetsAt) - 5 * 3600_000).toISOString() : null,
            queued,
          }
        : null,
    };
  }

  async flowCounts(): Promise<z.input<typeof DeskViewSchema>["flow"]> {
    const { db } = this.d;
    const grouped = await db.increment.groupBy({ by: ["status"], _count: true });
    const count = (s: string) => grouped.find((g) => g.status === s)?._count ?? 0;
    const inGates = await db.run.count({
      where: { status: "PHASE", stateJson: { contains: '"phase":"GATES"' }, increment: { status: "RUNNING" } },
    });
    return {
      asked: this.d.proposals.list().length,
      toInitial: count("CONTEXT_READY"),
      building: count("RUNNING") - inGates + count("PARKED"),
      checking: count("VERIFYING") + inGates,
      toSeal: count("AWAITING_SIGNATURE"),
      landedToday: (await this.mergedSince(startOfToday())).length,
    };
  }

  /** Merged steps since a time, newest first, with their merge time and commit when known. */
  private async mergedSince(since: Date, limit = 500) {
    const rows = await this.d.db.increment.findMany({
      where: { status: "MERGED" },
      include: { feature: { select: { id: true, title: true, repoPath: true } } },
    });
    const events = await this.d.db.featureEvent.findMany({
      where: { kind: "merged", incrementId: { in: rows.map((r) => r.id) } },
    });
    return rows
      .map((r) => {
        const st = readJson(r.stateJson);
        const ev = events.find((e) => e.incrementId === r.id);
        const mergedAt = new Date(str(st["mergedAt"]) ?? r.updatedAt.toISOString());
        const sha = str(readJson(ev?.payloadJson ?? "{}")["sha"]) ?? str(st["sha"]);
        const onTrust = Array.isArray(st["onTrust"]) ? (st["onTrust"] as unknown[]).length : 0;
        return { row: r, mergedAt, sha, onTrust };
      })
      .filter((m) => m.mergedAt >= since)
      .sort((a, b) => b.mergedAt.getTime() - a.mergedAt.getTime())
      .slice(0, limit);
  }

  // ── a feature's thread ──

  async thread(featureId: string): Promise<ThreadView> {
    const { db } = this.d;
    const feature = await db.feature.findUnique({ where: { id: featureId } });
    if (!feature) {
      throw Object.assign(new Error(`feature not found: ${featureId}`), {
        signet: nonRecoverable("feature.not_found", `no feature with id ${featureId}`),
      });
    }
    const [steps, events, briefs] = await Promise.all([
      db.increment.findMany({ where: { featureId }, orderBy: { orderIndex: "asc" } }),
      db.featureEvent.findMany({ where: { featureId }, orderBy: { at: "asc" } }),
      db.briefVersion.findMany({ where: { featureId }, orderBy: { version: "asc" } }),
    ]);
    const escalations = await db.escalation.findMany({
      where: { incrementId: { in: steps.map((s) => s.id) } },
      orderBy: { createdAt: "asc" },
    });
    const runs = await db.run.findMany({
      where: { incrementId: { in: steps.map((s) => s.id) } },
      include: { phases: { orderBy: { enteredAt: "asc" } } },
      orderBy: { startedAt: "asc" },
    });
    const verdicts = await db.gateVerdict.findMany({
      where: { runId: { in: runs.map((r) => r.id) } },
      orderBy: { recordedAt: "asc" },
    });
    const stepNo = (id: string | null) => steps.findIndex((s) => s.id === id) + 1;
    const titleOf = (id: string | null) => steps.find((s) => s.id === id)?.title ?? "a step";

    type Ev = z.input<typeof ThreadViewSchema>["events"][number];
    const out: Ev[] = [];
    const push = (e: Omit<Ev, "lines"> & { lines?: string[] }) => out.push({ lines: [], ...e });

    // What was asked and proposed. Older features have no events, so the first request
    // version stands in for "you asked".
    const asked = events.find((e) => e.kind === "asked");
    if (asked) {
      push({ at: asked.at.toISOString(), who: "you", title: "You asked", detail: str(readJson(asked.payloadJson)["goal"]), incrementId: null });
    } else if (briefs[0]) {
      push({ at: briefs[0].frozenAt.toISOString(), who: "you", title: "You asked", detail: firstParagraph(briefs[0].contentMd), incrementId: null });
    }
    for (const e of events) {
      const p = readJson(e.payloadJson);
      const at = e.at.toISOString();
      switch (e.kind) {
        case "proposed": {
          const n = num(p["steps"]) ?? steps.length;
          const read = num(p["filesSurveyed"]);
          push({
            at,
            who: "signet",
            title: `Signet proposed ${n === 1 ? "one step" : `${n} steps`}`,
            detail: [read !== null ? `Read ${read} files.` : null, str(p["note"])].filter(Boolean).join(" ") || null,
            incrementId: null,
          });
          break;
        }
        case "initialled":
          push({
            at,
            who: "you",
            title: stepNo(e.incrementId) <= 1 && steps.length > 0 ? "You initialled the plan" : `You initialled step ${stepNo(e.incrementId)}`,
            detail: str(p["note"]) ?? (num(p["spentUsd"]) === 0 || p["spentUsd"] === undefined ? "Nothing had been spent yet." : null),
            incrementId: e.incrementId as never,
          });
          break;
        case "answered":
          push({ at, who: "you", title: "You answered", detail: str(p["answer"]), incrementId: e.incrementId as never });
          break;
        case "sent_back":
          push({ at, who: "you", title: `You sent step ${stepNo(e.incrementId)} back with ${num(p["notes"]) ?? 1} ${num(p["notes"]) === 1 ? "note" : "notes"}`, detail: str(p["first"]), incrementId: e.incrementId as never });
          break;
        case "merged":
          push({ at, who: "you", title: `You sealed step ${stepNo(e.incrementId)}`, detail: str(p["sha"]) ? `Landed on main as ${String(p["sha"]).slice(0, 7)}.` : null, incrementId: e.incrementId as never });
          break;
        case "taken_back":
          push({ at, who: "you", title: `You took back “${titleOf(e.incrementId)}”`, detail: null, incrementId: e.incrementId as never });
          break;
      }
    }

    // Runs: what was written, what the checks said, how it ended.
    for (const run of runs) {
      const n = stepNo(run.incrementId);
      const title = titleOf(run.incrementId);
      const implement = run.phases.filter((p) => p.phase === "AGENT_IMPLEMENT");
      const gates = run.phases.filter((p) => p.phase === "GATES");
      const firstImpl = implement[0];
      if (firstImpl?.completedAt) {
        const edited = [...new Set((await this.d.log.read(run.id)).filter((a) => a.kind === "edit" && a.path).map((a) => a.path as string))];
        push({
          at: firstImpl.completedAt.toISOString(),
          who: "signet",
          title: `Step ${n} · wrote the code`,
          detail: edited.length > 0 ? edited.join(", ") : null,
          incrementId: run.incrementId as never,
        });
      }
      gates.forEach((g, i) => {
        const next = gates[i + 1];
        const round = verdicts.filter((v) => v.runId === run.id && v.recordedAt >= g.enteredAt && (!next || v.recordedAt < next.enteredAt));
        const failed = round.filter((v) => v.outcome === "fail");
        if (failed.length === 0 || !g.completedAt) return;
        const findings = failed.flatMap((v) => {
          const f = readJson(`{"f":${v.findingsJson}}`)["f"];
          return Array.isArray(f) ? f.map((x) => str((x as Record<string, unknown>)["message"]) ?? "").filter(Boolean) : [];
        });
        const names = failed.map((v) => (v.gate === "typecheck" ? "Types" : v.gate === "tests" ? "Tests" : v.gate[0]?.toUpperCase() + v.gate.slice(1)));
        push({
          at: g.completedAt.toISOString(),
          who: "signet",
          title: `${names.join(" and ")} failed · ${findings.length} ${findings.length === 1 ? "finding" : "findings"}`,
          detail: null,
          lines: findings.slice(0, 4),
          incrementId: run.incrementId as never,
        });
        if (next) {
          push({
            at: g.completedAt.toISOString(),
            who: "signet",
            title: `Sent back to the agent with ${findings.length === 1 ? "the finding" : findings.length === 2 ? "both findings" : "the findings"}`,
            detail: `Repair ${i + 1} of 3. You were not asked — this is the checks doing their job.`,
            incrementId: run.incrementId as never,
          });
        }
      });
      const lastGate = gates.at(-1);
      if (gates.length > 1 && lastGate?.completedAt && run.status === "SUCCEEDED") {
        push({ at: lastGate.completedAt.toISOString(), who: "signet", title: "Checks passed", detail: "Every finding fixed.", incrementId: run.incrementId as never });
      }
      if (run.finishedAt && run.status === "SUCCEEDED") {
        const inc = steps.find((s) => s.id === run.incrementId);
        const merged = inc?.status === "MERGED";
        push({
          at: run.finishedAt.toISOString(),
          who: "signet",
          title: `Step ${n} ${merged ? "landed" : "built"} · ${title}`,
          detail: gates.length <= 1 ? "Checks passed first time." : `Checks sent it back ${gates.length - 1 === 1 ? "once" : `${gates.length - 1} times`}; fixed.`,
          incrementId: run.incrementId as never,
        });
      }
      if (run.finishedAt && run.status === "FAILED") {
        push({ at: run.finishedAt.toISOString(), who: "signet", title: `Step ${n} failed`, detail: str(readJson(run.stateJson)["errorCode"]), incrementId: run.incrementId as never });
      }
    }

    for (const e of escalations) {
      const st = readJson(e.stateJson);
      const fence = st["fence"] as { outside?: string[] } | undefined;
      push({
        at: e.createdAt.toISOString(),
        who: e.status === "RAISED" ? "ask" : "signet",
        title: fence?.outside ? `It wanted to change ${fence.outside.join(", ")}, outside this step’s fence` : "Stopped to ask rather than guess",
        detail: null,
        incrementId: e.incrementId as never,
      });
    }

    out.sort((a, b) => a.at.localeCompare(b.at));

    // The step being worked on now, if any.
    const live = steps.find((s) => s.status === "RUNNING" || s.status === "VERIFYING");
    let now: z.input<typeof ThreadViewSchema>["now"] = null;
    if (live) {
      const runId = str(readJson(live.stateJson)["runId"]);
      const run = runs.find((r) => r.id === runId);
      const current = run?.phases.filter((p) => !p.completedAt).at(-1) ?? run?.phases.at(-1);
      if (run && current) {
        const idx = RUN_PHASE_ORDER.indexOf(current.phase as never);
        const actions = await this.d.log.read(run.id);
        const last = [...actions].reverse().find((a) => (a.kind === "edit" || a.kind === "read") && a.path);
        const spent = await db.usageLedgerEntry.aggregate({ where: { runId: run.id }, _sum: { costUsd: true } });
        now = {
          incrementId: live.id,
          runId: run.id,
          stepIndex: stepNo(live.id),
          stepTitle: live.title,
          phase: current.phase,
          phases: RUN_PHASE_ORDER.map((_, i) => (i < idx ? "d" : i === idx ? "n" : "")),
          phaseEnteredAt: current.enteredAt.toISOString(),
          doing: last ? `${last.kind === "edit" ? "editing" : "reading"} ${last.path}` : null,
          spentUsd: money(spent._sum.costUsd),
        };
      }
    }

    const spent = await db.usageLedgerEntry.aggregate({ where: { run: { incrementId: { in: steps.map((s) => s.id) } } }, _sum: { costUsd: true } });
    return ThreadViewSchema.parse({
      featureId,
      title: feature.title,
      repoLabel: feature.repoLabel ?? this.d.configuredRepoLabel,
      events: out,
      steps: steps.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        said: SAID[s.status] ?? s.status.toLowerCase(),
        yours: YOURS.has(s.status),
        surface: s.declaredSurface,
        // The live run, or — for a step waiting on a question — the run that asked it.
        runId:
          str(readJson(s.stateJson)["runId"]) ??
          [...runs].filter((r) => r.incrementId === s.id).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0]?.id ??
          null,
        repairs: s.repairAttempt,
      })),
      now,
      spentUsd: money(spent._sum.costUsd),
      runs: runs.length,
      repairs: steps.reduce((n, s) => n + s.repairAttempt, 0),
    });
  }

  // ── flow: the canal ──

  async canal(): Promise<CanalView> {
    const { db } = this.d;
    const open = await db.increment.findMany({
      where: { status: { in: ["CONTEXT_READY", "RUNNING", "VERIFYING", "PARKED", "ESCALATED", "AWAITING_SIGNATURE"] } },
      include: { feature: { select: { id: true, title: true } } },
      orderBy: { updatedAt: "asc" },
    });
    const runIds = open.map((i) => str(readJson(i.stateJson)["runId"])).filter((x): x is string => x !== null);
    const runs = await db.run.findMany({ where: { id: { in: runIds } } });
    const boat = (i: (typeof open)[number], note: string, yours: boolean, progress: number | null) => ({
      title: i.title,
      featureTitle: i.feature.title,
      featureId: i.feature.id,
      incrementId: i.id,
      progress,
      note,
      yours,
    });

    const planned = [
      ...this.d.proposals.list().map((p) => ({
        title: p.goal.split("\n")[0]?.slice(0, 80) ?? "A new request",
        featureTitle: p.repoLabel,
        featureId: null,
        incrementId: null,
        progress: Math.min(90, Math.round(((Date.now() - p.startedAt.getTime()) / 90_000) * 100)),
        note: "reading the repo",
        yours: false,
      })),
      ...open.filter((i) => i.status === "CONTEXT_READY").map((i) => boat(i, "waiting for your initials", true, null)),
    ];

    const building = await Promise.all(
      open
        .filter((i) => i.status !== "CONTEXT_READY")
        .map(async (i) => {
          if (i.status === "AWAITING_SIGNATURE") {
            const p = await this.d.work.promises(i.id);
            const proven = p.promises.filter((x) => x.proven).length;
            return boat(i, p.checked ? `${proven} of ${p.promises.length} proven · waiting for your seal` : "waiting for your seal", true, null);
          }
          if (i.status === "ESCALATED") return boat(i, "waiting for your answer", true, null);
          if (i.status === "PARKED") return boat(i, "waiting for your Claude quota", false, 0);
          const run = runs.find((r) => r.id === str(readJson(i.stateJson)["runId"]));
          const phase = str(readJson(run?.stateJson ?? "{}")["phase"]) ?? "ASSEMBLE_PACK";
          const idx = Math.max(0, RUN_PHASE_ORDER.indexOf(phase as never));
          const note = phase === "GATES" ? "checking" : i.repairAttempt > 0 ? `repair ${i.repairAttempt}` : phase === "AGENT_IMPLEMENT" ? "writing the code" : "reading";
          return boat(i, note, false, Math.round(((idx + 0.5) / RUN_PHASE_ORDER.length) * 100));
        }),
    );

    const landed = (await this.mergedSince(startOfToday())).map((m) => ({
      title: m.row.title,
      featureTitle: m.row.feature.title,
      featureId: m.row.feature.id,
      incrementId: m.row.id,
      progress: 100,
      note: "on main",
      yours: false,
    }));

    return CanalViewSchema.parse({ planned, building, landed, identity: await identity() });
  }

  // ── flow: the ledger ──

  async ledger(): Promise<LedgerView> {
    const { db } = this.d;
    const merged = await this.mergedSince(new Date(0), 100);
    const ids = merged.map((m) => m.row.id);
    const [runs, events, briefs, answers, reverts] = await Promise.all([
      db.run.findMany({ where: { incrementId: { in: ids } }, include: { usage: { select: { costUsd: true } } } }),
      db.featureEvent.findMany({ where: { OR: [{ incrementId: { in: ids } }, { featureId: { in: merged.map((m) => m.row.featureId) }, kind: "asked" }] } }),
      db.briefVersion.findMany({ where: { id: { in: merged.map((m) => m.row.briefVersionId) } } }),
      db.escalation.findMany({ where: { incrementId: { in: ids }, status: "ANSWERED" }, orderBy: { updatedAt: "desc" } }),
      db.increment.findMany({ where: { revertsIncrementId: { in: ids }, status: "MERGED" }, select: { revertsIncrementId: true } }),
    ]);
    // Merges from before the commit was recorded: found in git by their message.
    const shaFromGit = async (id: string, repoPath: string | null): Promise<string | null> => {
      try {
        const { stdout } = await pexec("git", ["log", this.d.baseRef, "-1", "--format=%H", "--grep", `signet: merge increment ${id}`], {
          cwd: repoPath ?? this.d.configuredRepoPath,
        });
        return stdout.trim() || null;
      } catch {
        return null;
      }
    };
    const entries = await Promise.all(
      merged.map(async (m) => {
        const r = m.row;
        const sha = m.sha ?? (await shaFromGit(r.id, r.feature.repoPath));
        const mine = runs.filter((x) => x.incrementId === r.id);
        const cost = mine.flatMap((x) => x.usage).reduce<number | null>((n, u) => (u.costUsd === null ? n : (n ?? 0) + Number(u.costUsd)), null);
        const p = await this.d.work.promises(r.id);
        const asked = events.find((e) => e.kind === "asked" && e.featureId === r.featureId);
        const initialled = events.find((e) => e.kind === "initialled" && e.incrementId === r.id);
        const firstRun = [...mine].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0];
        const buildMs = mine.reduce<number | null>((n, x) => (x.finishedAt ? (n ?? 0) + (x.finishedAt.getTime() - x.startedAt.getTime()) : n), null);
        const answer = answers.find((a) => a.incrementId === r.id);
        const later = merged.filter((o) => o.row.featureId === r.featureId && o.mergedAt > m.mergedAt && o.row.orderIndex > r.orderIndex);
        return {
          incrementId: r.id,
          featureId: r.feature.id,
          title: r.title,
          featureTitle: r.feature.title,
          mergedAt: m.mergedAt.toISOString(),
          sha,
          proven: p.checked ? p.promises.filter((x) => x.proven).length : null,
          promises: p.checked ? p.promises.length : null,
          onTrust: m.onTrust,
          repairs: r.repairAttempt,
          costUsd: cost,
          record: {
            askedAt: (asked?.at ?? r.createdAt).toISOString(),
            briefVersion: briefs.find((b) => b.id === r.briefVersionId)?.version ?? 1,
            answer: answer ? str(readJson(answer.stateJson)["answer"]) : null,
            initialledAt: (initialled?.at ?? firstRun?.startedAt ?? null)?.toISOString() ?? null,
            runs: mine.length,
            buildMs,
          },
          builtOnTop: later.map((o) => o.row.title),
          takenBack: reverts.some((x) => x.revertsIncrementId === r.id),
        };
      }),
    );
    return LedgerViewSchema.parse({ entries, identity: await identity() });
  }
}

/** The check names, in the order the sheet reads them out. */
const CHECK_ORDER = ["typecheck", "lint", "tests", "conformance", "rules", "promises"];

export class StepViews {
  constructor(private readonly d: PlaceDeps) {}

  private repoOf(f: { repoPath: string | null; repoLabel: string | null }) {
    return { path: f.repoPath ?? this.d.configuredRepoPath, label: f.repoLabel ?? this.d.configuredRepoLabel };
  }

  /** Everything a signing sheet shows about one step. */
  async sheet(incrementId: string): Promise<StepSheet> {
    const { db } = this.d;
    const inc = await db.increment.findUnique({ where: { id: incrementId }, include: { feature: true } });
    if (!inc) {
      throw Object.assign(new Error(`increment not found: ${incrementId}`), {
        signet: nonRecoverable("increment.not_found", `no step with id ${incrementId}`),
      });
    }
    const peers = await db.increment.findMany({ where: { featureId: inc.featureId }, orderBy: { orderIndex: "asc" } });
    const runs = await db.run.findMany({ where: { incrementId }, orderBy: { startedAt: "desc" } });
    const latest = runs[0];
    const verdicts = latest ? await db.gateVerdict.findMany({ where: { runId: latest.id }, orderBy: { recordedAt: "asc" } }) : [];
    const lastByGate = new Map<string, string>();
    for (const v of verdicts) lastByGate.set(v.gate, v.outcome);
    const brief = await db.briefVersion.findUnique({ where: { id: inc.briefVersionId } });
    const answered = await db.escalation.findMany({ where: { incrementId, status: "ANSWERED" }, orderBy: { updatedAt: "asc" } });
    const spent = await db.usageLedgerEntry.aggregate({ where: { run: { incrementId } }, _sum: { costUsd: true } });
    const repo = this.repoOf(inc.feature);
    const st = readJson(inc.stateJson);
    const mergedEvent = await db.featureEvent.findFirst({ where: { incrementId, kind: "merged" }, orderBy: { at: "desc" } });

    let files: number | null = null;
    let added: number | null = null;
    let removed: number | null = null;
    if (inc.status === "AWAITING_SIGNATURE" || inc.status === "VERIFYING") {
      const diff = await this.d.diffs.read(incrementId);
      if (diff.available) {
        files = diff.files.length;
        added = diff.files.reduce((n, f) => n + f.added, 0);
        removed = diff.files.reduce((n, f) => n + f.removed, 0);
      }
    }
    const likely = await this.likelyCost(repo.path);
    const idx = peers.findIndex((p) => p.id === incrementId);
    const next = peers[idx + 1];

    return StepSheetSchema.parse({
      incrementId,
      featureId: inc.featureId,
      title: inc.title,
      featureTitle: inc.feature.title,
      status: inc.status,
      stepIndex: idx + 1,
      stepCount: peers.length,
      repoLabel: repo.label,
      repoPath: repo.path,
      base: this.d.baseRef,
      surface: inc.declaredSurface,
      acceptance: inc.acceptanceMd,
      identity: await identity(),
      likelyUsd: likely.usd,
      likelySample: likely.sample,
      spentUsd: money(spent._sum.costUsd),
      builtAt: latest?.status === "SUCCEEDED" && latest.finishedAt ? latest.finishedAt.toISOString() : null,
      repairs: inc.repairAttempt,
      files,
      added,
      removed,
      checks: CHECK_ORDER.filter((g) => lastByGate.has(g)).map((gate) => ({ gate, outcome: lastByGate.get(gate) ?? "" })),
      briefVersion: brief?.version ?? 1,
      answers: answered.map((a) => str(readJson(a.stateJson)["answer"])).filter((a): a is string => a !== null),
      mergedAt: str(st["mergedAt"]),
      sha: str(readJson(mergedEvent?.payloadJson ?? "{}")["sha"]) ?? str(st["sha"]),
      onTrust: Array.isArray(st["onTrust"]) ? (st["onTrust"] as unknown[]).map(String) : [],
      takenBack: (await db.increment.count({ where: { revertsIncrementId: incrementId, status: "MERGED" } })) > 0,
      next: next ? { title: next.title, status: next.status } : null,
    });
  }

  /**
   * What a step here usually costs: the mean spend of the last twelve steps built in the
   * same repo. Null with no history — an estimate from nothing is a guess, not a number.
   */
  async likelyCost(repoPath: string): Promise<{ usd: number | null; sample: number }> {
    const { db } = this.d;
    const recent = await db.increment.findMany({
      where: {
        status: { in: ["MERGED", "AWAITING_SIGNATURE"] },
        feature: repoPath === this.d.configuredRepoPath ? { OR: [{ repoPath }, { repoPath: null }] } : { repoPath },
      },
      orderBy: { updatedAt: "desc" },
      take: 12,
      select: { id: true },
    });
    if (recent.length === 0) return { usd: null, sample: 0 };
    const costs = await Promise.all(
      recent.map(async (r) => money((await db.usageLedgerEntry.aggregate({ where: { run: { incrementId: r.id } }, _sum: { costUsd: true } }))._sum.costUsd)),
    );
    const known = costs.filter((c): c is number => c !== null);
    if (known.length === 0) return { usd: null, sample: 0 };
    return { usd: known.reduce((a, b) => a + b, 0) / known.length, sample: known.length };
  }

  /** Which branch the step's repo has checked out — the seal only lands on the base. */
  async checkout(incrementId: string): Promise<CheckoutView> {
    const inc = await this.d.db.increment.findUnique({ where: { id: incrementId }, include: { feature: true } });
    const repo = inc ? this.repoOf(inc.feature) : { path: this.d.configuredRepoPath, label: this.d.configuredRepoLabel };
    let branch = "HEAD";
    try {
      branch = (await pexec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo.path })).stdout.trim();
    } catch {
      branch = "unknown";
    }
    return CheckoutViewSchema.parse({ repoPath: repo.path, branch, base: this.d.baseRef, onBase: branch === this.d.baseRef });
  }
}

function firstParagraph(md: string): string {
  return md.replace(/^#+.*$/gm, "").trim().split(/\n\s*\n/)[0]?.trim() ?? md;
}
