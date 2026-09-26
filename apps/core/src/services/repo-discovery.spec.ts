// Repo discovery, pinned.
//
// The two things that matter here are what it REFUSES to offer and how it reports a
// limitation.
//
// The first version of this listed Signet's own increment worktrees — `inc-<uuid>`
// directories under the workspaces root — as repositories you could send work to. They
// are git checkouts, so a naive scan finds them, and on the pilot machine that meant
// eight of the first nine suggestions were Signet's own scratch space. Picking one is
// never what anybody meant.
//
// The second is the github boundary: a github repo can be planned against but not
// merged into, because merging needs a push. That has to be stated where the choice is
// made. A limitation you discover when the merge fails is a bug; one you are told about
// before you start is a boundary.

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoDiscovery } from "./repo-discovery.js";

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** A sandbox holding a configured repo, a sibling repo, and Signet's own worktrees. */
async function sandbox(): Promise<{ configured: string; sibling: string; workspaces: string }> {
  const root = await mkdtemp(join(tmpdir(), "signet-discovery-"));
  roots.push(root);
  const configured = join(root, "demo-repo");
  const sibling = join(root, "other-project");
  const workspaces = join(root, "workspaces");
  for (const dir of [configured, sibling, join(workspaces, "inc-aaaa"), join(workspaces, "inc-bbbb")]) {
    await mkdir(dir, { recursive: true });
    // A worktree's .git is a FILE, not a directory — which is exactly why the check is
    // for the entry existing rather than for a directory.
    await writeFile(join(dir, ".git"), "gitdir: elsewhere\n");
  }
  return { configured, sibling, workspaces };
}

const noGithub = { listRepos: async () => ({ authenticated: false, login: null, repos: [], truncated: false }) };

describe("what it refuses to offer", () => {
  it("excludes Signet's own increment worktrees", async () => {
    // On the pilot machine this was eight of the first nine suggestions.
    const { configured, workspaces } = await sandbox();
    const d = new RepoDiscovery({ configuredRepoPath: configured, workspacesRoot: workspaces, github: noGithub });
    const { repos } = await d.list();
    expect(repos.some((r) => r.label.includes("inc-aaaa"))).toBe(false);
    expect(repos.some((r) => r.label.includes("inc-bbbb"))).toBe(false);
  });

  it("still finds a real repo sitting beside the configured one", async () => {
    // The exclusion must not be so broad that it removes genuine neighbours.
    const { configured, sibling, workspaces } = await sandbox();
    const d = new RepoDiscovery({ configuredRepoPath: configured, workspacesRoot: workspaces, github: noGithub });
    const { repos } = await d.list();
    expect(repos.some((r) => r.id === sibling)).toBe(true);
  });
});

describe("the configured repo", () => {
  it("is always offered, even if the scan missed it", async () => {
    // It is the one repo known to work, so its absence would be the worst possible gap.
    const d = new RepoDiscovery({
      configuredRepoPath: "/somewhere/not/scanned/my-repo",
      github: noGithub,
    });
    const { repos } = await d.list();
    expect(repos.some((r) => r.id === "/somewhere/not/scanned/my-repo")).toBe(true);
  });

  it("is offered first, so the safe default is not buried", async () => {
    const { configured, workspaces } = await sandbox();
    const d = new RepoDiscovery({ configuredRepoPath: configured, workspacesRoot: workspaces, github: noGithub });
    const { repos } = await d.list();
    expect(repos[0]?.id).toBe(configured);
    expect(repos[0]?.isConfigured).toBe(true);
  });
});

describe("the github boundary", () => {
  it("marks github repos as unable to be merged into, with a reason", async () => {
    const { configured, workspaces } = await sandbox();
    const real = new RepoDiscovery({
      configuredRepoPath: configured,
      workspacesRoot: workspaces,
      github: {
        listRepos: async () => ({
          authenticated: true,
          login: "someone",
          truncated: false,
          repos: [
            {
              fullName: "someone/thing",
              description: null,
              private: false,
              language: "TypeScript",
              updatedAt: "2026-09-26T00:00:00.000Z",
              defaultBranch: "main",
            },
          ],
        }),
      },
    });
    const { repos } = await real.list();
    const gh = repos.find((r) => r.id === "github:someone/thing");
    expect(gh?.canMerge).toBe(false);
    expect(gh?.limitation).toMatch(/cannot merge/i);
    // No path until somebody asks: nothing is cloned to fill a dropdown.
    expect(gh?.path).toBeNull();
  });

  it("keeps the local list when github fails, and says why", async () => {
    // GitHub being unreachable must not take the local repos with it — the picker is
    // still useful, and a swallowed reason is worse than a stated one.
    const { configured, sibling, workspaces } = await sandbox();
    const d = new RepoDiscovery({
      configuredRepoPath: configured,
      workspacesRoot: workspaces,
      github: {
        listRepos: async () => {
          throw new Error("gh not installed");
        },
      },
    });
    const { repos, github } = await d.list();
    expect(repos.some((r) => r.id === sibling)).toBe(true);
    expect(github.authenticated).toBe(false);
    expect(github.reason).toContain("gh not installed");
  });
});

describe("resolving what the picker sent back", () => {
  it("treats an empty choice as the configured repo", async () => {
    const d = new RepoDiscovery({ configuredRepoPath: "/repos/demo", github: noGithub });
    expect(d.resolve(undefined)).toMatchObject({ path: "/repos/demo", origin: "local" });
  });

  it("keeps a github choice as github, with no path yet", async () => {
    // The caller clones and fills the path in; resolve only records the choice.
    const d = new RepoDiscovery({ configuredRepoPath: "/repos/demo", github: noGithub });
    expect(d.resolve("github:owner/name")).toMatchObject({ label: "owner/name", origin: "github", path: "" });
  });

  it("passes an absolute path straight through, so a typed path works", async () => {
    // Free text is always valid: the list is a shortcut, never a constraint.
    const d = new RepoDiscovery({ configuredRepoPath: "/repos/demo", github: noGithub });
    expect(d.resolve("/elsewhere/project")).toMatchObject({ path: "/elsewhere/project", origin: "local" });
  });
});
