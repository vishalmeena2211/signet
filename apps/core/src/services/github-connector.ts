// Learn from a GitHub repository by URL, not just a local path.
//
// Every choice here is from measurement rather than intuition, because the obvious
// answers are wrong in ways that fail silently:
//
// · SHALLOW clone by DATE, never a partial clone. A blobless clone
//   (`--filter=blob:none`) looks ideal — 4.2M vs 11M on express — but it makes the
//   one operation the learner actually needs, `git grep <old-rev>`, 300–500x
//   slower: 17–28 seconds per rev against 51ms, because every historical grep
//   triggers an on-demand fetch of that tree's blobs. It also fails outright
//   offline. A shallow clone keeps complete trees for the commits it has, so
//   historical greps stay local and instant.
//
// · `--shallow-since` rather than `--depth=N`. The learner asks date questions, and
//   a commit count is a terrible proxy for a date: the same 13-month window is 91
//   commits in express and 918 in react. Sizing by commits misses by 10x.
//
// · Never assume the default branch is `main`. expressjs/express is still `master`,
//   and `--branch main` fails outright there.
//
// · `--mirror`, never `--bare`, for a cache. `git clone --bare` sets NO fetch
//   refspec, so `git fetch` silently refuses to advance the branch — exit code 0,
//   no warning, and the cache serves month-old HEAD forever.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { nonRecoverable, recoverable } from "@signet/contracts";
import type { Logger } from "../domain/runtime/logger.js";

const pexec = promisify(execFile);

/** Margin over the learner's 12-month lookback, so a query is never at the edge. */
const HISTORY = "13 months ago";

export const GithubSourceSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});
export type GithubSource = z.infer<typeof GithubSourceSchema>;

/**
 * Accepts the forms people actually paste: an https URL with or without .git, an
 * ssh URL, or a bare owner/repo.
 */
export function parseGithubRef(input: string): GithubSource | null {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const patterns = [
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)/,
    /^git@github\.com:([^/\s]+)\/([^/\s]+)/,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+)/,
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  ];
  for (const p of patterns) {
    const m = p.exec(s);
    if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] };
  }
  return null;
}

export interface ClonedRepo {
  readonly path: string;
  readonly label: string;
  readonly defaultBranch: string;
  readonly headSha: string;
  /** Oldest commit available locally — the boundary beyond which history is absent. */
  readonly oldestCommitDate: string;
  readonly commitCount: number;
  readonly fromCache: boolean;
}

export class GithubConnector {
  constructor(
    private readonly log: Logger,
    /** XDG-style cache root, so clones live with other tool caches, not in the repo. */
    private readonly cacheRoot = join(
      process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"),
      "signet",
      "repos",
      "github.com",
    ),
  ) {}

  /** Argv arrays, never interpolated strings — a shell would word-split these. */
  private async git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await pexec("git", args, {
      ...(cwd ? { cwd } : {}),
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, // never hang waiting for a password
    });
    return stdout.trim();
  }

  /**
   * The user's own `gh` login, if present. Preferred over asking for a token: it
   * is already in the OS keyring, already consented to, independently revocable,
   * and means we never store a secret of our own.
   */
  private async token(): Promise<string | null> {
    const fromEnv = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
    if (fromEnv) return fromEnv;
    try {
      const { stdout } = await pexec("gh", ["auth", "token"]);
      const t = stdout.trim();
      return t.length > 0 ? t : null;
    } catch {
      return null; // gh absent or not logged in; public repos still work
    }
  }

  /** Ask GitHub for the default branch rather than guessing it. */
  private async defaultBranch(src: GithubSource): Promise<string> {
    const token = await this.token();
    const res = await fetch(`https://api.github.com/repos/${src.owner}/${src.repo}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "signet-learner",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (res.status === 404) {
      throw Object.assign(new Error(`repository not found: ${src.owner}/${src.repo}`), {
        signet: nonRecoverable(
          "github.not_found",
          `GitHub has no repository ${src.owner}/${src.repo}, or your login cannot see it.`,
        ),
      });
    }
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      throw Object.assign(new Error("github rate limited"), {
        signet: recoverable(
          "github.rate_limited",
          remaining === "0"
            ? "GitHub's rate limit is exhausted. Signing in with `gh auth login` raises it from 60 to 5,000 requests an hour."
            : "GitHub refused the request — a secondary rate limit, most likely. Try again shortly.",
        ),
      });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`github ${res.status}`), {
        signet: recoverable("github.unavailable", `GitHub returned ${res.status}.`),
      });
    }
    const body = (await res.json()) as { default_branch?: string };
    return body.default_branch ?? "main";
  }

  /**
   * Clone or refresh the cache, and return a checkout the learner can read.
   * Refreshing never re-clones: fetch, then hard-reset to the upstream, because a
   * plain `git fetch` leaves the local branch behind its remote-tracking ref.
   */
  async fetchRepo(input: string): Promise<ClonedRepo> {
    const src = parseGithubRef(input);
    if (!src) {
      throw Object.assign(new Error(`unrecognised GitHub reference: ${input}`), {
        signet: nonRecoverable(
          "github.bad_reference",
          "That does not look like a GitHub repository. Try a URL like https://github.com/owner/repo, or just owner/repo.",
        ),
      });
    }

    const dir = join(this.cacheRoot, src.owner, src.repo);
    const label = src.repo;
    let fromCache = false;

    const alreadyThere = await this.isRepo(dir);
    if (alreadyThere) {
      fromCache = true;
      this.log.info("github.cache_refresh", { owner: src.owner, repo: src.repo });
      try {
        await this.git(["fetch", "origin"], dir);
        // Without the reset, HEAD stays where it was while origin/HEAD moves on,
        // and every HEAD-vs-history comparison is quietly wrong.
        await this.git(["reset", "--hard", "@{u}"], dir);
      } catch (e) {
        // A corrupt or half-cloned cache should heal itself, not block the user.
        this.log.warn("github.cache_unusable", { dir, error: String(e) });
        await rm(dir, { recursive: true, force: true });
        fromCache = false;
      }
    }

    if (!fromCache) {
      const branch = await this.defaultBranch(src);
      await mkdir(join(this.cacheRoot, src.owner), { recursive: true });
      this.log.info("github.clone", { owner: src.owner, repo: src.repo, branch, since: HISTORY });
      try {
        await this.git([
          "clone",
          `--shallow-since=${HISTORY}`,
          "--single-branch",
          "--branch",
          branch,
          "--no-tags",
          `https://github.com/${src.owner}/${src.repo}.git`,
          dir,
        ]);
      } catch (e) {
        const msg = String(e);
        throw Object.assign(new Error(`clone failed: ${msg}`), {
          signet: /Authentication|could not read Username|Permission denied/i.test(msg)
            ? nonRecoverable(
                "github.auth_required",
                "That repository needs authentication. Run `gh auth login`, or set GITHUB_TOKEN.",
              )
            : recoverable("github.clone_failed", `Could not clone it: ${firstLine(msg)}`),
        });
      }
      await writeFile(join(dir, ".signet-cache.json"), JSON.stringify({ since: HISTORY }), "utf8").catch(() => {});
    }

    const [headSha, allDates, count, branch] = await Promise.all([
      this.git(["rev-parse", "HEAD"], dir),
      // NOT `log --reverse -1`: git applies the -1 limit BEFORE reversing, so that
      // returns HEAD rather than the oldest commit. Measured against a real clone
      // it reported 17 days of history where 13 months were present — and since
      // this number exists to tell the truth about the trend window, a wrong one
      // is worse than none.
      this.git(["log", "--format=%cI", "HEAD"], dir).catch(() => ""),
      this.git(["rev-list", "--count", "HEAD"], dir),
      this.git(["rev-parse", "--abbrev-ref", "HEAD"], dir),
    ]);
    const lines = allDates.split("\n").filter((l) => l.length > 0);
    const oldest = lines[lines.length - 1] ?? "";

    return {
      path: dir,
      label,
      defaultBranch: branch,
      headSha,
      oldestCommitDate: oldest,
      commitCount: Number(count) || 0,
      fromCache,
    };
  }

  private async isRepo(dir: string): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--git-dir"], dir);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deepen the clone when a query predates the boundary. Cheap — a few seconds —
   * and far better than over-cloning every repository up front.
   */
  async deepen(dir: string, since: string): Promise<void> {
    this.log.info("github.deepen", { dir, since });
    await this.git(["fetch", `--shallow-since=${since}`, "origin"], dir);
  }

  /** Whether the cache actually has history back to a date. */
  async hasHistoryBefore(dir: string, isoDate: string): Promise<boolean> {
    const rev = await this.git(["rev-list", "-1", `--before=${isoDate}`, "HEAD"], dir).catch(() => "");
    return rev.length > 0;
  }

  async cachedSince(dir: string): Promise<string | null> {
    try {
      const raw = await readFile(join(dir, ".signet-cache.json"), "utf8");
      const parsed = z.object({ since: z.string() }).safeParse(JSON.parse(raw)); // signet-policy-allow: raw-json-parse -- validated on this line
      return parsed.success ? parsed.data.since : null;
    } catch {
      return null;
    }
  }
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? s;
}
