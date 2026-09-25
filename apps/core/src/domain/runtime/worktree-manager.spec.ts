import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorktreeManager } from "./worktree-manager.js";

const exec = promisify(execFile);

let repo: string;
let workspaces: string;
let mgr: WorktreeManager;

async function git(args: string[], cwd: string) {
  await exec("git", args, { cwd });
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "signet-repo-"));
  workspaces = await mkdtemp(join(tmpdir(), "signet-ws-"));
  await git(["init", "-b", "main"], repo);
  await writeFile(join(repo, "hello.txt"), "hello\n");
  await git(["add", "-A"], repo);
  await git(
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"],
    repo,
  );
  mgr = new WorktreeManager(repo, workspaces);
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(workspaces, { recursive: true, force: true });
});

describe("worktree lifecycle", () => {
  it("acquires an isolated worktree on its own branch", async () => {
    const res = await mgr.acquire("11111111-aaaa-bbbb-cccc-000000000001", "main");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.branch).toBe("signet/inc-11111111-aaaa-bbbb-cccc-000000000001");
    // isolated: writing here does not touch the main checkout
    await writeFile(join(res.value.path, "feature.txt"), "new\n");
    const sha = await mgr.commitAll(res.value, "increment work");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const changed = await mgr.changedFiles(res.value, "main");
    expect(changed).toEqual(["feature.txt"]);
    await mgr.release(res.value, { removeWorktree: true });
  });

  it("commitAll on a clean tree returns null (idempotent finalize)", async () => {
    const res = await mgr.acquire("11111111-aaaa-bbbb-cccc-000000000002", "main");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await mgr.commitAll(res.value, "nothing")).toBeNull();
    await mgr.release(res.value, { removeWorktree: true });
  });

  it("a live foreign lock yields a conflict error, not a crash", async () => {
    const id = "11111111-aaaa-bbbb-cccc-000000000003";
    // Simulate another live holder: our own pid counts as live-but-same, so
    // fake a foreign live pid (pid 1 / launchd is always alive on macOS).
    await writeFile(join(workspaces, `inc-${id}.lock`), "1");
    const res = await mgr.acquire(id, "main");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("conflict");
    expect(res.error.code).toBe("workspace.locked");
    await rm(join(workspaces, `inc-${id}.lock`), { force: true });
  });

  it("a dead pid's stale lock is replaced (crash recovery)", async () => {
    const id = "11111111-aaaa-bbbb-cccc-000000000004";
    await writeFile(join(workspaces, `inc-${id}.lock`), "999999");
    const res = await mgr.acquire(id, "main");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await mgr.release(res.value, { removeWorktree: true });
  });

  it("re-acquire after crash reuses the surviving worktree", async () => {
    const id = "11111111-aaaa-bbbb-cccc-000000000005";
    const first = await mgr.acquire(id, "main");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await writeFile(join(first.value.path, "wip.txt"), "wip\n");
    // simulate crash: lock file remains, process "dies" — replace pid with dead one
    await writeFile(first.value.lockPath, "999999");
    const second = await mgr.acquire(id, "main");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // the wip file survived — cross-run persistence through the local cwd
    const changed = await mgr.commitAll(second.value, "recovered wip");
    expect(changed).not.toBeNull();
    await mgr.release(second.value, { removeWorktree: true });
  });
});
