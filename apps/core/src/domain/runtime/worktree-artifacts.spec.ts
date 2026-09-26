// Signet's own files must not reach a commit.
//
// The adapter writes .claude/settings.json into every worktree as its sandbox
// profile. `git add -A` used to commit it, which meant the customer's repository
// gained our permission file in its history at merge — and a file outside the
// increment's declared surface slipped past the scope check. These tests cover
// both shapes of repository: one that has no .claude of its own, and one that
// tracks its own settings and must get it back untouched.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorktreeManager } from "./worktree-manager.js";

const pexec = promisify(execFile);
const made: string[] = [];

afterEach(async () => {
  for (const p of made.splice(0)) await rm(p, { recursive: true, force: true }).catch(() => {});
});

async function git(args: string[], cwd: string) {
  await pexec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
}

async function repoWith(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "signet-artifacts-"));
  made.push(dir);
  await git(["init", "-b", "main"], dir);
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true }).catch(() => {});
    await writeFile(join(dir, rel), body);
  }
  await git(["add", "-A"], dir);
  await git(["commit", "-m", "base"], dir);
  return dir;
}

async function acquire(repo: string) {
  const ws = await mkdtemp(join(tmpdir(), "signet-artifacts-ws-"));
  made.push(ws);
  const wt = new WorktreeManager(repo, ws);
  const got = await wt.acquire("11111111-aaaa-4bbb-8ccc-00000000aa01", "main");
  if (!got.ok) throw new Error("could not acquire a worktree");
  return { wt, handle: got.value };
}

/** Stands in for the adapter writing its permission profile. */
async function writeSandboxProfile(path: string, marker: string) {
  await mkdir(join(path, ".claude"), { recursive: true });
  await writeFile(join(path, ".claude", "settings.json"), JSON.stringify({ signet: marker }));
}

describe("worktree commits exclude Signet's own artifacts", () => {
  it("a repo with no .claude of its own gets none: the profile never lands in the commit", async () => {
    const repo = await repoWith({ "app.mjs": "export const a = 1;\n" });
    const { wt, handle } = await acquire(repo);

    await writeSandboxProfile(handle.path, "ours");
    await writeFile(join(handle.path, "feature.mjs"), "export const f = 2;\n");
    const sha = await wt.commitAll(handle, "signet: increment");
    expect(sha).toBeTruthy();

    const { stdout } = await pexec("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: handle.path });
    const committed = stdout.trim().split("\n");
    expect(committed).toContain("feature.mjs");
    expect(committed).not.toContain(".claude/settings.json");
    // And nothing of ours is left lying around either.
    await expect(access(join(handle.path, ".claude"))).rejects.toThrow();
  });

  it("a repo that tracks its own .claude/settings.json gets its version back, not ours", async () => {
    const theirs = JSON.stringify({ theirs: "keep me" });
    const repo = await repoWith({
      "app.mjs": "export const a = 1;\n",
      ".claude/settings.json": theirs,
      ".claude/other.md": "their other file\n",
    });
    const { wt, handle } = await acquire(repo);

    await writeSandboxProfile(handle.path, "ours"); // the adapter overwrites theirs
    await writeFile(join(handle.path, "feature.mjs"), "export const f = 2;\n");
    await wt.commitAll(handle, "signet: increment");

    // Their settings are restored verbatim...
    expect(await readFile(join(handle.path, ".claude", "settings.json"), "utf8")).toBe(theirs);
    // ...their other files survive (the cleanup must not delete a real .claude)...
    expect(await readFile(join(handle.path, ".claude", "other.md"), "utf8")).toContain("their other file");
    // ...and the commit says nothing about .claude at all.
    const { stdout } = await pexec("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: handle.path });
    expect(stdout).not.toContain(".claude");
    expect(stdout).toContain("feature.mjs");
  });
});
