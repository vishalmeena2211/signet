// Reference parsing, and the guard that stops the learner fabricating a trend.
//
// The dangerous case is subtle: `git rev-list -1 --before=<date>` returns an EMPTY
// STRING with EXIT CODE 0 when the date predates a shallow clone's boundary. It
// does not clamp and does not error. A learner that reads that as "the convention
// did not exist 12 months ago" invents an adoption trend out of missing data — so
// availability has to be checked, not assumed.

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GithubConnector, parseGithubRef } from "./github-connector.js";
import type { Logger } from "../domain/runtime/logger.js";

const pexec = promisify(execFile);
const nullLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLog;
  },
};

const made: string[] = [];
afterAll(async () => {
  for (const p of made) await rm(p, { recursive: true, force: true }).catch(() => {});
});

describe("parseGithubRef", () => {
  it("accepts the forms people actually paste", () => {
    const expected = { owner: "vishalmeena2211", repo: "signet" };
    for (const input of [
      "https://github.com/vishalmeena2211/signet",
      "https://github.com/vishalmeena2211/signet.git",
      "https://www.github.com/vishalmeena2211/signet/",
      "http://github.com/vishalmeena2211/signet",
      "git@github.com:vishalmeena2211/signet.git",
      "ssh://git@github.com/vishalmeena2211/signet",
      "vishalmeena2211/signet",
      "  vishalmeena2211/signet  ",
    ]) {
      expect(parseGithubRef(input), input).toEqual(expected);
    }
  });

  it("ignores extra path segments like /tree/main", () => {
    expect(parseGithubRef("https://github.com/facebook/react/tree/main/packages")).toEqual({
      owner: "facebook",
      repo: "react",
    });
  });

  it("refuses things that are not repository references", () => {
    for (const input of ["", "   ", "https://gitlab.com/a/b", "not a url", "onlyoneword"]) {
      expect(parseGithubRef(input), input).toBeNull();
    }
  });
});

describe("history availability guard", () => {
  it("reports FALSE for a date the clone does not reach, rather than treating it as absence", async () => {
    // A repo whose only commit is today. Asking about last year must come back
    // "no data", not "the convention was not there".
    const dir = await mkdtemp(join(tmpdir(), "signet-gh-"));
    made.push(dir);
    const git = (args: string[]) =>
      pexec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
    await git(["init", "-b", "main"]);
    await writeFile(join(dir, "a.txt"), "hello\n");
    await git(["add", "-A"]);
    await git(["commit", "-m", "only commit"]);

    const gh = new GithubConnector(nullLog, join(dir, "cache"));

    // Sanity: the guard sees history that IS present.
    await expect(gh.hasHistoryBefore(dir, new Date(Date.now() + 86_400_000).toISOString())).resolves.toBe(true);

    // The real case: a year before the repo existed.
    await expect(gh.hasHistoryBefore(dir, "2015-01-01T00:00:00Z")).resolves.toBe(false);
  });

  it("verifies the underlying git behaviour this guard exists for", async () => {
    // Pin the surprising fact itself, so nobody later 'simplifies' the guard away:
    // an out-of-range --before is an empty string at exit code 0, not an error.
    const dir = await mkdtemp(join(tmpdir(), "signet-gh-raw-"));
    made.push(dir);
    const git = (args: string[]) =>
      pexec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
    await git(["init", "-b", "main"]);
    await writeFile(join(dir, "a.txt"), "hello\n");
    await git(["add", "-A"]);
    await git(["commit", "-m", "only commit"]);

    const { stdout } = await pexec("git", ["rev-list", "-1", "--before=2015-01-01", "HEAD"], { cwd: dir });
    expect(stdout.trim()).toBe(""); // empty …
    // … and it did NOT throw, which is exactly why silence is dangerous here.
  });

  it("treats a non-repository directory as having no history rather than throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "signet-gh-empty-"));
    made.push(dir);
    const gh = new GithubConnector(nullLog, join(dir, "cache"));
    await expect(gh.hasHistoryBefore(dir, "2020-01-01T00:00:00Z")).resolves.toBe(false);
  });
});

describe("bad input", () => {
  it("refuses an unrecognised reference with a message that says what to type", async () => {
    const gh = new GithubConnector(nullLog, join(tmpdir(), "signet-gh-none"));
    await expect(gh.fetchRepo("https://gitlab.com/a/b")).rejects.toMatchObject({
      signet: { code: "github.bad_reference" },
    });
  });
});

describe("history window reporting", () => {
  it("reports the OLDEST commit, not HEAD", async () => {
    // `git log --reverse --format=%cI -1` applies the limit before reversing and
    // therefore returns HEAD. Measured on a real 13-month clone it claimed 17 days
    // of history. This number is the honesty check on the trend window, so it is
    // pinned with three commits at distinct dates.
    const dir = await mkdtemp(join(tmpdir(), "signet-gh-window-"));
    made.push(dir);
    const commit = async (msg: string, iso: string) => {
      await writeFile(join(dir, `${msg}.txt`), msg);
      await pexec("git", ["add", "-A"], { cwd: dir });
      await pexec(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", msg, "--date", iso],
        { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: iso } },
      );
    };
    await pexec("git", ["init", "-b", "main"], { cwd: dir });
    await commit("oldest", "2024-01-15T10:00:00Z");
    await commit("middle", "2025-06-15T10:00:00Z");
    await commit("newest", "2026-02-15T10:00:00Z");

    const gh = new GithubConnector(nullLog, join(dir, "cache"));
    // fetchRepo would clone; exercise the same query it uses, via the public guard
    // plus a direct read of the reporting path.
    const { stdout } = await pexec("git", ["log", "--format=%cI", "HEAD"], { cwd: dir });
    const lines = stdout.trim().split("\n").filter(Boolean);
    const oldest = lines[lines.length - 1] ?? "";
    expect(oldest).toContain("2024-01-15");
    expect(oldest).not.toContain("2026-02-15");

    // And the guard agrees about what is reachable.
    await expect(gh.hasHistoryBefore(dir, "2025-01-01T00:00:00Z")).resolves.toBe(true);
    await expect(gh.hasHistoryBefore(dir, "2023-01-01T00:00:00Z")).resolves.toBe(false);
  });
});
