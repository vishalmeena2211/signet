#!/usr/bin/env node
// `pnpm console` — one command to get Signet running locally.
//
// Brings up the embedded Postgres if it is not already up, applies migrations,
// builds whatever is stale, then runs core (which also serves the console).
// Nothing here is interactive and nothing needs env vars set by hand: the whole
// point is that "run it locally" is one command, not a runbook.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { access, mkdir, writeFile } from "node:fs/promises";

const pexec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = join(repoRoot, "apps", "core");

const HOME = join(homedir(), ".signet");
const env = {
  ...process.env,
  SIGNET_DATABASE_URL: process.env.SIGNET_DATABASE_URL ?? "postgresql://signet:signet@127.0.0.1:5765/signet",
  SIGNET_TARGET_REPO_PATH: process.env.SIGNET_TARGET_REPO_PATH ?? join(HOME, "demo-repo"),
  SIGNET_WORKSPACES_ROOT: process.env.SIGNET_WORKSPACES_ROOT ?? join(HOME, "workspaces"),
  SIGNET_PACKS_ROOT: process.env.SIGNET_PACKS_ROOT ?? join(HOME, "packs"),
};

function step(msg) {
  process.stdout.write(`\x1b[2m→\x1b[0m ${msg}\n`);
}

async function run(cmd, args, cwd = repoRoot) {
  await pexec(cmd, args, { cwd, env, maxBuffer: 32 * 1024 * 1024 });
}

async function portOpen(port) {
  try {
    await pexec("nc", ["-z", "127.0.0.1", String(port)]);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts the database and resolves when it is ACCEPTING CONNECTIONS, not when the
 * process exits — `dev-db.mjs up` is a supervisor that deliberately stays alive to
 * own the embedded Postgres, so awaiting it waits forever.
 *
 * This is why `pnpm console` hung on a cold start: the database came up fine and
 * the launcher sat on a promise that could never settle. It went unnoticed because
 * a database left running from earlier takes the other branch, so the one path a
 * new machine always takes was the one path never exercised.
 *
 * Returns the child so the caller can stop it on the way out. Postgres is its
 * child, and would otherwise outlive the launcher that started it.
 */
async function startDatabase(port) {
  const child = spawn("node", ["scripts/dev-db.mjs", "up"], {
    cwd: coreDir,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  let exited = null;
  child.on("exit", (code) => (exited = code ?? 0));

  // initdb on a first run is slow, so the ceiling is generous. Poll the port
  // rather than the log: "listening" in stdout is a claim, a TCP connect is proof.
  for (let waited = 0; waited < 90_000; waited += 250) {
    if (await portOpen(port)) return child;
    if (exited !== null) {
      throw new Error(`the database exited with code ${exited} before opening ${port}\n${stderr.trim()}`);
    }
    await sleep(250);
  }
  child.kill("SIGTERM");
  throw new Error(`the database never opened ${port} within 90s\n${stderr.trim()}`);
}

/**
 * The demo repository the README promises: a tiny JavaScript cart module with tests, on
 * a main branch, for watching a feature go end to end before trusting Signet with a repo
 * you care about.
 *
 * Nothing used to make it. It existed on the machine Signet was written on because it
 * had been made by hand, so a fresh install pointed at a folder that was not there and
 * the first screen said "Nothing can start". Made only when you have not named a repo of
 * your own, and never over anything already there.
 */
async function ensureDemoRepo(path) {
  try {
    await access(join(path, ".git"));
    return;
  } catch {
    /* not there yet: make it */
  }
  try {
    await access(path);
    // Something is already at that path that is not a git repo. Leave it alone; the
    // health page says what is wrong, and deleting a user's folder is never the fix.
    return;
  } catch {
    /* free */
  }
  step(`making the demo repository at ${path}`);
  await mkdir(path, { recursive: true });
  const files = {
    "package.json": JSON.stringify({ name: "signet-demo", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
    "README.md": "# Signet demo\n\nA tiny cart module for trying Signet on. Ask for something small, like\n\"add itemCount(items) to cart.mjs\", and watch it go from a sentence to a merge.\n",
    "cart.mjs": [
      "export const total = (items) => items.reduce((sum, i) => sum + i.price, 0);",
      "",
      "export const withDiscount = (items, percent) => Math.round(total(items) * (100 - percent)) / 100;",
      "",
      "export const cheapest = (items) =>",
      "  items.reduce((lo, i) => (i.price < lo.price ? i : lo), items[0] ?? null);",
      "",
    ].join("\n"),
    "cart.test.mjs": [
      'import { strict as assert } from "node:assert";',
      'import { test } from "node:test";',
      'import { cheapest, total, withDiscount } from "./cart.mjs";',
      "",
      'test("total adds up the prices", () => {',
      "  assert.equal(total([{ price: 2 }, { price: 3 }]), 5);",
      "});",
      "",
      'test("withDiscount takes a percentage off the total", () => {',
      "  assert.equal(withDiscount([{ price: 100 }], 10), 90);",
      "});",
      "",
      'test("cheapest finds the lowest price, or null for an empty cart", () => {',
      "  assert.deepEqual(cheapest([{ price: 3 }, { price: 1 }]), { price: 1 });",
      "  assert.equal(cheapest([]), null);",
      "});",
      "",
    ].join("\n"),
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(path, name), text);
  const git = (args) => pexec("git", args, { cwd: path });
  await git(["init", "-q", "-b", "main"]);
  await git(["add", "-A"]);
  // Its own identity: a fresh machine may have no git name set, and this is Signet's commit.
  await git(["-c", "user.name=signet", "-c", "user.email=signet@local", "commit", "-qm", "A small cart module to try Signet on"]);
}

async function main() {
  for (const dir of [env.SIGNET_WORKSPACES_ROOT, env.SIGNET_PACKS_ROOT]) await mkdir(dir, { recursive: true });
  if (!process.env.SIGNET_TARGET_REPO_PATH) await ensureDemoRepo(env.SIGNET_TARGET_REPO_PATH);

  if (await portOpen(4700)) {
    console.error(
      "Something is already listening on 4700. Stop it first (pkill -f 'node dist/main.js') — two cores on one database would both dispatch the same runs.",
    );
    process.exit(1);
  }

  // Null when a database was already running: we did not start it, so we must not
  // stop it on the way out — that would take down something we do not own.
  let database = null;
  if (await portOpen(5765)) {
    step("database already up on 5765");
  } else {
    step("starting embedded postgres on 5765");
    database = await startDatabase(5765);
  }

  step("applying migrations");
  await run("pnpm", ["exec", "prisma", "migrate", "deploy"], coreDir);

  // The console is served from packages/ui/dist but the UI is NOT a dependency
  // of core, so building only core's graph would serve a stale console. Name it
  // explicitly — this bit silently shipped yesterday's UI once already.
  //
  // `pnpm check` runs `build` first for the same reason. Its test task depends on
  // `^build`, which builds a package's DEPENDENCIES and not the package itself, so
  // check used to leave ui/dist untouched: you could change a screen, watch check
  // go green, reload, and be looking at the previous build. Keep `build` in check.
  step("building (turbo skips what is unchanged)");
  await run("pnpm", ["turbo", "run", "build", "--filter=@signet/core...", "--filter=@signet/ui"]);

  step("core + console → http://127.0.0.1:4700");
  const child = spawn("node", ["dist/main.js"], { cwd: coreDir, env, stdio: "inherit" });
  const stop = () => {
    child.kill("SIGTERM");
    // Ctrl-C reaches the launcher, not the database it spawned. Without this the
    // Postgres supervisor survives, and the next `pnpm console` silently reuses a
    // database whose lifetime nobody is tracking.
    database?.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => {
    database?.kill("SIGTERM");
    process.exit(code ?? 0);
  });
}

main().catch((e) => {
  console.error(`\nFailed to start: ${e.message}`);
  if (e.stderr) console.error(e.stderr.toString().trim());
  process.exit(1);
});
