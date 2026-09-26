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
 * Migrated once, then cloned per suite. Postgres can create a database FROM a
 * template in about a hundred milliseconds, which is what makes a database per
 * suite affordable — running migrations six times would not be.
 */
const TEMPLATE_SUITE = "template";

/**
 * The developer's URL with the database name suffixed. Returns null when no URL
 * is configured, so suites can skip rather than fail on a machine with no
 * database running.
 *
 * SIGNET_DATABASE_URL must be listed under the `test` task's `env` in turbo.json
 * or turbo will not pass it through, and every database-backed suite silently
 * skips. `pnpm check` reported green for a while on that basis — 28 skipped tests
 * reading as a pass. Listing it also folds it into the cache key, so a run with a
 * database cannot reuse the result of a run without one.
 */
export function testDatabaseUrl(suite?: string): string | null {
  const base = process.env["SIGNET_DATABASE_URL"];
  if (!base) return null;
  const u = new URL(base);
  const name = u.pathname.replace(/^\//, "");
  if (!name) return null;
  const root = name.endsWith(TEST_SUFFIX) ? name.slice(0, -TEST_SUFFIX.length) : name;

  // A database PER SUITE. They used to share one, and since teardown truncates
  // everything, whichever suite finished first wiped the data out from under the
  // others — vitest runs spec files in parallel. The shared version passed under
  // `pnpm check` purely by scheduling luck and failed consistently when run
  // directly, which is the worst way for a test suite to be wrong.
  //
  // The suite name goes BEFORE the marker, not after: `signet_gatestory_test`,
  // never `signet_test_gatestory`. That keeps the guard's rule exactly as strict
  // as it was — "must END in _test" — instead of loosening it to "must contain
  // _test", which would also have admitted things like `signet_test_backup`.
  const name_ = suite ? `${root}_${suite.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()}${TEST_SUFFIX}` : `${root}${TEST_SUFFIX}`;
  u.pathname = `/${name_}`;
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

let templateReady: string | null = null;

/**
 * Creates the test database if it does not exist and brings its schema up to
 * date, once per process. Migrations are applied with the same `migrate deploy`
 * the application uses, so the tests run against the real schema rather than a
 * hand-maintained copy that can drift.
 */
/** CREATE DATABASE, tolerating "already exists" and nothing else. */
async function createDatabase(adminUrl: string, name: string, template?: string): Promise<void> {
  // The identifier cannot be parameterised, so it is validated rather than
  // escaped. It comes from our own suffixing, but validating keeps that true if
  // the source ever changes.
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error(`unsafe database name: ${name}`);
  if (template && !/^[a-zA-Z0-9_]+$/.test(template)) throw new Error(`unsafe template name: ${template}`);

  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: adminUrl }) });
  try {
    await admin.$executeRawUnsafe(
      template ? `CREATE DATABASE "${name}" TEMPLATE "${template}"` : `CREATE DATABASE "${name}"`,
    );
  } catch (e) {
    // 42P04 is "already exists", the normal case on a second run. Anything else
    // is a real failure and must surface.
    if (!/already exists|42P04/i.test(String(e))) throw e;
  } finally {
    await admin.$disconnect();
  }
}

/**
 * Creates the per-suite database, cloning a migrated template so migrations run
 * once per process rather than once per suite.
 */
export async function prepareTestDatabase(url: string): Promise<void> {
  assertDisposable(url);

  const target = new URL(url);
  const dbName = target.pathname.replace(/^\//, "");
  // Strip the suite segment back off to find the shared root, so every suite
  // clones the same template.
  const withoutMarker = dbName.slice(0, -TEST_SUFFIX.length);
  const root = withoutMarker.includes("_") ? withoutMarker.slice(0, withoutMarker.lastIndexOf("_")) : withoutMarker;
  const templateName = `${root}_${TEMPLATE_SUITE}${TEST_SUFFIX}`;

  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";

  if (templateReady !== templateName) {
    await createDatabase(adminUrl.toString(), templateName);
    const templateUrl = new URL(url);
    templateUrl.pathname = `/${templateName}`;
    // The real migrations, so suites run against the real schema rather than a
    // hand-maintained copy that can drift.
    await pexec("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: CORE_DIR,
      env: { ...process.env, SIGNET_DATABASE_URL: templateUrl.toString() },
      maxBuffer: 16 * 1024 * 1024,
    });
    templateReady = templateName;
  }

  if (dbName !== templateName) await createDatabase(adminUrl.toString(), dbName, templateName);
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
export async function setupTestDatabase(
  /** Unique per spec file. Two suites sharing a name share a database, and a
   *  truncating teardown then wipes one from under the other. */
  suite: string,
): Promise<{ db: PrismaClient; url: string } | null> {
  const url = testDatabaseUrl(suite);
  if (!url) return null;
  await prepareTestDatabase(url);
  const db = testClient(url);
  // Start from empty rather than trusting the last run's teardown: a suite that
  // crashed mid-way would otherwise leave rows for the next one to trip over.
  await truncateAll(db, url);
  return { db, url };
}
