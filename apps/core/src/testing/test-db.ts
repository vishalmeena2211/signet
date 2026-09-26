// A database the tests own, so they cannot damage the one you work in.
//
// Every database-backed spec used to connect to SIGNET_DATABASE_URL — the
// developer's own database — and clean up by deleting the rows it remembered
// creating. That fails in two ways, and both happened:
//
//   · A teardown that throws leaks everything after the throw. One foreign-key
//     mistake in a cleanup left 22 features on the board.
//   · A fixture with invalid data poisons real storage. A spec wrote an
//     increment state with no runId, and from then on the console returned
//     422 increment.corrupt_state for that feature.
//
// The fix is not more careful cleanup. It is a separate database plus a teardown
// that cannot miss anything: TRUNCATE every table. Deleting by remembered id can
// forget a row; truncating the schema cannot.
//
// That is only safe because of the guard below — this module refuses to operate
// on any database whose name does not end in `_test`, so a mistyped environment
// variable cannot point the truncation at real data.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../persistence/generated/client.js";

const pexec = promisify(execFile);
const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Suffix that marks a database as disposable. The guard keys on this. */
const TEST_SUFFIX = "_test";

/**
 * The developer's URL with the database name suffixed. Returns null when no URL
 * is configured, so suites can skip rather than fail on a machine with no
 * database running.
 */
export function testDatabaseUrl(): string | null {
  const base = process.env["SIGNET_DATABASE_URL"];
  if (!base) return null;
  const u = new URL(base);
  const name = u.pathname.replace(/^\//, "");
  if (!name) return null;
  // Already a test database (a nested call, or a CI override): leave it alone.
  u.pathname = `/${name.endsWith(TEST_SUFFIX) ? name : name + TEST_SUFFIX}`;
  return u.toString();
}

/**
 * The guard. Nothing destructive in this module runs without passing it, and it
 * is checked at the point of use rather than once at setup — a helper that can be
 * pointed at the wrong database by a later edit is not a guard.
 */
function assertDisposable(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith(TEST_SUFFIX)) {
    throw new Error(
      `refusing to operate on "${name}": this helper only touches databases ending in ${TEST_SUFFIX}. ` +
        `Something is pointing the test database at real data.`,
    );
  }
}

let prepared: string | null = null;

/**
 * Creates the test database if it does not exist and brings its schema up to
 * date, once per process. Migrations are applied with the same `migrate deploy`
 * the application uses, so the tests run against the real schema rather than a
 * hand-maintained copy that can drift.
 */
export async function prepareTestDatabase(url: string): Promise<void> {
  assertDisposable(url);
  if (prepared === url) return;

  const target = new URL(url);
  const dbName = target.pathname.replace(/^\//, "");

  // Connect to the maintenance database to issue CREATE DATABASE, which cannot
  // run inside the database it creates.
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const adminClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: admin.toString() }) });
  try {
    // Postgres has no CREATE DATABASE IF NOT EXISTS, and the identifier cannot be
    // parameterised — so the name is validated rather than escaped. It comes from
    // our own suffixing, but validating keeps that true if the source changes.
    if (!/^[a-zA-Z0-9_]+$/.test(dbName)) throw new Error(`unsafe database name: ${dbName}`);
    await adminClient.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } catch (e) {
    // 42P04 is "database already exists", which is the normal case after the
    // first run. Anything else is a real failure and must surface.
    const msg = String(e);
    if (!/already exists|42P04/i.test(msg)) throw e;
  } finally {
    await adminClient.$disconnect();
  }

  await pexec("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: CORE_DIR,
    env: { ...process.env, SIGNET_DATABASE_URL: url },
    maxBuffer: 16 * 1024 * 1024,
  });

  prepared = url;
}

/** A client on the test database. */
export function testClient(url: string): PrismaClient {
  assertDisposable(url);
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/**
 * Empties every table. Unconditional and id-free, so unlike per-row cleanup it
 * cannot forget something — which is the whole point. RESTART IDENTITY keeps
 * sequences from drifting across runs; CASCADE removes the need to know the
 * foreign-key order, which is what the leaking teardown got wrong.
 */
export async function truncateAll(db: PrismaClient, url: string): Promise<void> {
  assertDisposable(url);
  const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(
    `select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations'`,
  );
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Everything a database-backed suite needs, or null when no database is
 * configured. Suites use the null to skip, so `pnpm test` still works on a
 * machine with nothing running.
 */
export async function setupTestDatabase(): Promise<{ db: PrismaClient; url: string } | null> {
  const url = testDatabaseUrl();
  if (!url) return null;
  await prepareTestDatabase(url);
  return { db: testClient(url), url };
}
