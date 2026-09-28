// Taking a step back.
//
// A merge is undone by a revert commit, never by rewriting history — and the revert is
// itself a change that lands on main, so it goes through the seal like any other: a new
// step whose work is `git revert -m 1` of the merge, waiting for your seal. Anything
// merged later in the same feature was built on top of it and is reverted with it, newest
// first; the ledger says so before you press anything.

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { conflict, nonRecoverable } from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";
import { WorktreeManager } from "../domain/runtime/worktree-manager.js";

const pexec = promisify(execFile);

export interface TakeBackDeps {
  db: PrismaClient;
  workspacesRoot: string;
  configuredRepoPath: string;
  baseRef: string;
}

function readJson(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw); // signet-policy-allow: raw-json-parse -- our own stored JSON, read field by field
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class TakeBack {
  constructor(private readonly d: TakeBackDeps) {}

  /** The merge commit a step landed as: recorded since merges kept it, found in git before. */
  private async shaOf(incrementId: string, repoPath: string): Promise<string | null> {
    const ev = await this.d.db.featureEvent.findFirst({ where: { incrementId, kind: "merged" }, orderBy: { at: "desc" } });
    const fromEvent = readJson(ev?.payloadJson ?? "{}")["sha"];
    if (typeof fromEvent === "string") return fromEvent;
    const inc = await this.d.db.increment.findUnique({ where: { id: incrementId }, select: { stateJson: true } });
    const fromState = readJson(inc?.stateJson ?? "{}")["sha"];
    if (typeof fromState === "string") return fromState;
    const { stdout } = await pexec("git", ["log", this.d.baseRef, "--format=%H", "-1", "--grep", `signet: merge increment ${incrementId}`], { cwd: repoPath }).catch(() => ({ stdout: "" }));
    return stdout.trim() || null;
  }

  async start(incrementId: string): Promise<{ incrementId: string; featureId: string }> {
    const { db } = this.d;
    const inc = await db.increment.findUnique({ where: { id: incrementId }, include: { feature: true } });
    if (!inc || inc.status !== "MERGED") {
      throw Object.assign(new Error("not merged"), {
        signet: conflict("take_back.not_merged", "Only a step that has landed on main can be taken back."),
      });
    }
    const already = await db.increment.findFirst({ where: { revertsIncrementId: incrementId, status: { not: "FAILED" } } });
    if (already) {
      throw Object.assign(new Error("already"), {
        signet: conflict("take_back.already", "This step is already being taken back — look for it on your Desk."),
      });
    }
    const repoPath = inc.feature.repoPath ?? this.d.configuredRepoPath;

    // This step, and everything merged after it in the same feature: newest first.
    const siblings = await db.increment.findMany({ where: { featureId: inc.featureId, status: "MERGED" } });
    const mergedAt = (s: { stateJson: string; updatedAt: Date }) => {
      const at = readJson(s.stateJson)["mergedAt"];
      return typeof at === "string" ? Date.parse(at) : s.updatedAt.getTime();
    };
    const mine = mergedAt(inc);
    const chain = siblings
      .filter((s) => s.id === inc.id || (mergedAt(s) > mine && s.orderIndex > inc.orderIndex && s.revertsIncrementId === null))
      .sort((a, b) => mergedAt(b) - mergedAt(a));
    const shas: string[] = [];
    for (const s of chain) {
      const sha = await this.shaOf(s.id, repoPath);
      if (!sha) {
        throw Object.assign(new Error("no sha"), {
          signet: nonRecoverable("take_back.no_commit", `Could not find the merge commit for “${s.title}” on ${this.d.baseRef}.`),
        });
      }
      shas.push(sha);
    }

    const newId = randomUUID();
    const runId = randomUUID();
    const worktrees = new WorktreeManager(repoPath, this.d.workspacesRoot);
    const acq = await worktrees.acquire(newId, this.d.baseRef, repoPath);
    if (!acq.ok) throw Object.assign(new Error(acq.error.message), { signet: acq.error });
    const git = (args: string[]) =>
      pexec("git", ["-c", "user.name=signet", "-c", "user.email=signet@local", ...args], { cwd: acq.value.path });
    try {
      for (const sha of shas) await git(["revert", "--no-edit", "-m", "1", sha]);
    } catch (e) {
      await git(["revert", "--abort"]).catch(() => {});
      await worktrees.release(acq.value, { removeWorktree: true });
      throw Object.assign(new Error(String(e)), {
        signet: conflict(
          "take_back.conflict",
          "Main has changed since, and taking this back would conflict with what came after. Nothing was changed.",
        ),
      });
    }
    await worktrees.release(acq.value, { removeWorktree: false });

    const { stdout: names } = await pexec("git", ["diff", "--name-only", `${this.d.baseRef}...HEAD`], { cwd: acq.value.path });
    const files = names.split("\n").filter(Boolean);
    const brief = await db.briefVersion.findFirst({ where: { featureId: inc.featureId }, orderBy: { version: "desc" } });
    const last = await db.increment.findFirst({ where: { featureId: inc.featureId }, orderBy: { orderIndex: "desc" } });
    const titles = chain.map((c) => `“${c.title}”`).join(" and ");

    await db.$transaction(async (tx) => {
      await tx.increment.create({
        data: {
          id: newId,
          featureId: inc.featureId,
          title: `Take back ${titles}`,
          status: "AWAITING_SIGNATURE",
          stateJson: JSON.stringify({ status: "AWAITING_SIGNATURE", runId }),
          declaredSurface: files,
          acceptanceMd: "",
          briefVersionId: brief?.id ?? inc.briefVersionId,
          orderIndex: (last?.orderIndex ?? inc.orderIndex) + 1,
          revertsIncrementId: inc.id,
        },
      });
      await tx.run.create({
        data: {
          id: runId,
          incrementId: newId,
          status: "SUCCEEDED",
          stateJson: JSON.stringify({ status: "SUCCEEDED" }),
          workspacePath: acq.value.path,
          finishedAt: new Date(),
        },
      });
    });
    return { incrementId: newId, featureId: inc.featureId };
  }
}
