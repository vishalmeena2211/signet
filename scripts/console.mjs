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
import { mkdir } from "node:fs/promises";

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

async function main() {
  for (const dir of [env.SIGNET_WORKSPACES_ROOT, env.SIGNET_PACKS_ROOT]) await mkdir(dir, { recursive: true });

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
