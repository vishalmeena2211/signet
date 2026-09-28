#!/usr/bin/env node
// Removes worktrees for steps that have already been merged, and stale lock files.
//
// New runs clean up after themselves: the merge path removes the worktree, and every
// terminal path releases the lock. This is for the backlog left by versions that did
// neither — fourteen worktrees and five dead-pid locks had accumulated before those
// fixes landed.
//
// It only touches worktrees whose increment is MERGED. An escalated, parked or failed
// step keeps its worktree, because that is the only place the evidence lives, and a
// parked one resumes into it.
//
// Deliberately reuses the same removeWorktreeFor the merge path calls, rather than
// reimplementing rm -rf here. A second copy of a teardown is a second chance to forget
// the prune, which is what leaves git reporting a worktree as "prunable" forever.

import { PrismaPg } from "@prisma/adapter-pg";
// From dist, not src: at runtime the generated client under src/ is TypeScript.
import { PrismaClient } from "../dist/persistence/generated/client.js";
import { removeWorktreeFor } from "../dist/domain/runtime/worktree-manager.js";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.SIGNET_DATABASE_URL;
if (!url) {
  console.error("SIGNET_DATABASE_URL is required.");
  process.exit(1);
}
const workspacesRoot = process.env.SIGNET_WORKSPACES_ROOT;
const targetRepo = process.env.SIGNET_TARGET_REPO_PATH;
if (!workspacesRoot || !targetRepo) {
  console.error("SIGNET_WORKSPACES_ROOT and SIGNET_TARGET_REPO_PATH are required.");
  process.exit(1);
}

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

/** Bytes on disk, for reporting what was actually recovered. */
async function sizeOf(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    let total = 0;
    for (const e of entries) {
      const full = join(path, e.name);
      if (e.isDirectory()) total += await sizeOf(full);
      else if (e.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size;
    }
    return total;
  } catch {
    return 0;
  }
}

const merged = await db.increment.findMany({
  where: { status: "MERGED" },
  select: { id: true, title: true, feature: { select: { repoPath: true } } },
});

let removed = 0;
let bytes = 0;
for (const inc of merged) {
  const path = join(workspacesRoot, `inc-${inc.id}`);
  const size = await sizeOf(path);
  if (size === 0) continue; // already gone
  await removeWorktreeFor({
    workspacesRoot,
    repoPath: inc.feature.repoPath ?? targetRepo,
    incrementId: inc.id,
  });
  removed += 1;
  bytes += size;
  console.log(`  · ${inc.title} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

// Locks whose holder has exited. acquire() already replaces these, so they block nothing
// — which is exactly why they were never noticed accumulating.
let locks = 0;
for (const name of await readdir(workspacesRoot).catch(() => [])) {
  if (!name.endsWith(".lock")) continue;
  const full = join(workspacesRoot, name);
  const pid = Number((await readFile(full, "utf8").catch(() => "")).trim());
  if (!Number.isFinite(pid) || pid <= 0) continue;
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (!alive) {
    await rm(full, { force: true });
    locks += 1;
  }
}

console.log(
  `Reaped ${removed} merged worktree(s), ${(bytes / 1024 / 1024).toFixed(1)} MB recovered, ` +
    `and ${locks} stale lock(s). Escalated, parked and failed steps were left alone.`,
);
await db.$disconnect();
