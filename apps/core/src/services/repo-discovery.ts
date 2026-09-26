// Which repositories you can send work to.
//
// Phase 0 had exactly one, set by SIGNET_TARGET_REPO_PATH, and the create form never
// mentioned it — so "which codebase is this going into" was answered by an env var
// nobody reads. That is fine for a single-project pilot and wrong the moment there are
// two, because the answer is invisible at the only point it matters.
//
// Two sources, deliberately not merged into a false equivalence:
//
//   · LOCAL git repos, found by scanning a few conventional roots. These work end to
//     end: survey, worktree, checks, and a real git merge.
//   · GITHUB repos, from the connector that already exists for learning. These can be
//     surveyed and planned against out of the clone cache, but a run cannot FINISH
//     into one, because merging means pushing — auth, branches, pull requests. That is
//     separate work, so they are returned with canMerge false and a reason, and the
//     picker says so at the moment of choosing. A limitation you discover when the
//     merge fails is a bug; one you are told about before you pick is a boundary.
//
// Scanning is breadth-limited and shallow on purpose. A recursive walk of a home
// directory is slow enough to make the form feel broken, and the roots people actually
// keep code in are few and conventional.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RepoOption, RepoOptionsResponse } from "@signet/contracts";
import type { GithubConnector } from "./github-connector.js";

/** Conventional places people keep repositories, relative to home. */
const HOME_ROOTS = ["Desktop", "Documents", "code", "src", "projects", "repos", "dev", "work", "git"];

/**
 * How deep to look under each root. Two levels catches `~/code/thing` and
 * `~/code/org/thing`, which covers most layouts without walking a whole disk.
 */
const MAX_DEPTH = 2;

/** A ceiling so a pathological tree cannot make the picker hang. */
const MAX_REPOS = 200;

/** Directories never worth descending into while looking for repos. */
const SKIP = new Set([
  "node_modules", ".git", "dist", "build", "out", ".turbo", "coverage",
  "Library", "Applications", ".Trash", ".npm", ".cache", "venv", ".venv",
  "target", "vendor", "Pods", ".gradle", ".m2",
]);

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    // A .git ENTRY, not necessarily a directory: a worktree's .git is a file.
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** Finds git repos under one root, without descending into repos it finds. */
async function scanRoot(root: string, found: Set<string>, depth = 0): Promise<void> {
  if (depth > MAX_DEPTH || found.size >= MAX_REPOS) return;

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // A root that does not exist is the normal case — most machines have three of
    // these nine, and a missing one is not an error worth surfacing.
    return;
  }

  for (const entry of entries) {
    if (found.size >= MAX_REPOS) return;
    if (!entry.isDirectory()) continue;
    if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;

    const dir = join(root, entry.name);
    if (await isGitRepo(dir)) {
      // Stop here rather than recursing: nested repos inside a repo are submodules or
      // vendored copies, not things you meant to pick.
      found.add(dir);
      continue;
    }
    await scanRoot(dir, found, depth + 1);
  }
}

export interface RepoDiscoveryDeps {
  /** The instance default, always offered and always first. */
  configuredRepoPath: string;
  /**
   * Where Signet puts its own worktrees. Excluded from the results: they ARE git
   * checkouts, so a naive scan offers eight `inc-<uuid>` directories as projects you
   * could send work to. They are Signet's scratch space, created and destroyed per
   * increment — picking one is never what anybody meant.
   */
  workspacesRoot?: string;
  github: Pick<GithubConnector, "listRepos">;
}

export class RepoDiscovery {
  constructor(private readonly deps: RepoDiscoveryDeps) {}

  /** The roots we look under, including the configured repo's own parent. */
  private roots(): string[] {
    const home = homedir();
    return [
      // So a repo sitting beside the configured one is found without configuration.
      dirname(this.deps.configuredRepoPath),
      ...HOME_ROOTS.map((r) => join(home, r)),
      home,
    ].filter((r, i, all) => all.indexOf(r) === i);
  }

  async list(): Promise<RepoOptionsResponse> {
    const roots = this.roots();
    const found = new Set<string>();
    for (const root of roots) await scanRoot(root, found);

    // Signet's own worktrees are git repos, and listing them as choices is noise at
    // best and destructive at worst. Filtered rather than deleted in place: mutating the
    // set we are iterating is legal but subtle, and this reads as what it is.
    const excluded = this.deps.workspacesRoot;
    const isOurs = (path: string): boolean =>
      excluded !== undefined && (path === excluded || path.startsWith(`${excluded}/`));

    const configured = this.deps.configuredRepoPath;
    const local: RepoOption[] = [
      // Always present even if the scan missed it — it is the one repo we know works.
      ...new Set([...[...found].filter((p) => !isOurs(p)), configured]),
    ]
      .sort((a, b) => a.localeCompare(b))
      .map((path) => ({
        id: path,
        label: path.replace(homedir(), "~"),
        origin: "local" as const,
        path,
        canMerge: true,
        limitation: null,
        detail: null,
        isConfigured: path === configured,
      }));

    // Configured first: it is the safe default and the one the user is most likely to
    // want, and burying it alphabetically among forty repos serves nobody.
    local.sort((a, b) => Number(b.isConfigured) - Number(a.isConfigured));

    let github: RepoOptionsResponse["github"] = { authenticated: false, reason: null };
    let githubOptions: RepoOption[] = [];
    try {
      const res = await this.deps.github.listRepos();
      github = { authenticated: res.authenticated, reason: res.reason ?? null };
      githubOptions = res.repos.map((r) => ({
        id: `github:${r.fullName}`,
        label: r.fullName,
        origin: "github" as const,
        // Null until cloned. The proposer clones on demand; nothing is fetched just to
        // populate a dropdown.
        path: null,
        canMerge: false,
        limitation: "Signet can plan against this, but cannot merge into it yet — that needs push access.",
        detail: [r.private ? "private" : null, r.language, `default ${r.defaultBranch}`]
          .filter(Boolean)
          .join(" · "),
        isConfigured: false,
      }));
    } catch (e) {
      // GitHub being unreachable must not take the local list with it. The picker is
      // still useful with local repos alone, and the reason is reported rather than
      // swallowed.
      github = { authenticated: false, reason: e instanceof Error ? e.message : String(e) };
    }

    return { repos: [...local, ...githubOptions], scannedRoots: roots, github };
  }

  /**
   * Resolves what the picker sent back into something a run can use.
   *
   * Returns the label and origin alongside the path because those are what get stored
   * on the feature: an absolute clone-cache path is noise on screen when what the user
   * picked was "owner/name".
   */
  resolve(repoId: string | undefined): { path: string; label: string; origin: "local" | "github" } {
    if (!repoId || repoId === this.deps.configuredRepoPath) {
      return {
        path: this.deps.configuredRepoPath,
        label: this.deps.configuredRepoPath.replace(homedir(), "~"),
        origin: "local",
      };
    }
    if (repoId.startsWith("github:")) {
      const fullName = repoId.slice("github:".length);
      // The caller clones and fills the real path in; this only records the choice.
      return { path: "", label: fullName, origin: "github" };
    }
    return { path: repoId, label: repoId.replace(homedir(), "~"), origin: "local" };
  }
}
