#!/usr/bin/env node
// Dev/test database: starts an embedded Postgres under .devdb/ and prints the
// connection URL. Used by `pnpm db:up`, tests, and CI — no system Postgres,
// no Docker, nothing to install. Production points SIGNET_DATABASE_URL at a
// real server and never touches this.

import EmbeddedPostgres from "embedded-postgres";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, ".devdb", "data");
const port = Number(process.env.SIGNET_DEVDB_PORT ?? 5765);

await mkdir(dataDir, { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "signet",
  password: "signet",
  port,
  persistent: true,
});

const action = process.argv[2] ?? "up";

if (action === "up") {
  // initialise() is idempotent-ish: only init if the cluster doesn't exist yet
  try {
    await pg.initialise();
  } catch {
    /* already initialised */
  }
  await pg.start();
  try {
    await pg.createDatabase("signet");
  } catch {
    /* exists */
  }
  console.log(`SIGNET_DATABASE_URL=postgresql://signet:signet@127.0.0.1:${port}/signet`);
  // stay alive as the DB supervisor until killed
  process.on("SIGINT", async () => {
    await pg.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await pg.stop();
    process.exit(0);
  });
} else if (action === "down") {
  await pg.stop();
  console.log("devdb stopped");
  process.exit(0);
} else {
  console.error(`unknown action: ${action} (use up|down)`);
  process.exit(1);
}
