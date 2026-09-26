// The guard that makes truncation safe.
//
// truncateAll() empties every table, which is only acceptable because it refuses
// to run anywhere but a database whose name ends in _test. That refusal is the
// single most important line in the testing helpers, so it is tested directly
// rather than trusted.

import { afterEach, describe, expect, it } from "vitest";
import { testDatabaseUrl, truncateAll } from "./test-db.js";

const ORIGINAL = process.env["SIGNET_DATABASE_URL"];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env["SIGNET_DATABASE_URL"];
  else process.env["SIGNET_DATABASE_URL"] = ORIGINAL;
});

describe("test database naming", () => {
  it("suffixes the developer's database rather than using it", () => {
    process.env["SIGNET_DATABASE_URL"] = "postgresql://signet:signet@127.0.0.1:5765/signet";
    expect(testDatabaseUrl()).toBe("postgresql://signet:signet@127.0.0.1:5765/signet_test");
  });

  it("gives each suite its OWN database, because teardown truncates everything", () => {
    // Sharing one meant whichever suite finished first wiped the others' data
    // mid-run. vitest runs spec files in parallel, so this is not a rare race.
    process.env["SIGNET_DATABASE_URL"] = "postgresql://signet:signet@127.0.0.1:5765/signet";
    expect(testDatabaseUrl("gatestory")).toBe("postgresql://signet:signet@127.0.0.1:5765/signet_gatestory_test");
    expect(testDatabaseUrl("crash")).not.toBe(testDatabaseUrl("e2e"));
  });

  it("puts the suite BEFORE the marker, so the guard stays strict", () => {
    process.env["SIGNET_DATABASE_URL"] = "postgresql://signet:signet@127.0.0.1:5765/signet";
    // signet_graph_test, never signet_test_graph. Suffixing the suite would have
    // forced the guard from "ends in _test" to "contains _test", which also
    // admits names like signet_test_backup — a real database someone cares about.
    for (const suite of ["graph", "brief", "ports"]) {
      expect(testDatabaseUrl(suite)).toMatch(/\/signet_[a-z]+_test$/);
    }
  });

  it("keeps credentials, host and port intact", () => {
    process.env["SIGNET_DATABASE_URL"] = "postgresql://u:p@db.internal:6543/app?sslmode=require";
    const url = new URL(testDatabaseUrl() as string);
    expect(url.username).toBe("u");
    expect(url.host).toBe("db.internal:6543");
    expect(url.pathname).toBe("/app_test");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it("does not double-suffix an already-disposable database", () => {
    process.env["SIGNET_DATABASE_URL"] = "postgresql://signet:signet@127.0.0.1:5765/ci_test";
    expect(testDatabaseUrl()).toBe("postgresql://signet:signet@127.0.0.1:5765/ci_test");
    expect(testDatabaseUrl("graph")).toBe("postgresql://signet:signet@127.0.0.1:5765/ci_graph_test");
  });

  it("returns null when nothing is configured, so suites skip rather than fail", () => {
    delete process.env["SIGNET_DATABASE_URL"];
    expect(testDatabaseUrl()).toBeNull();
  });
});

describe("the destructive guard", () => {
  /** A client stand-in: if the guard works, none of these are ever called. */
  const shouldNotBeUsed = {
    $queryRawUnsafe: () => {
      throw new Error("the guard let a query through");
    },
    $executeRawUnsafe: () => {
      throw new Error("THE GUARD LET A TRUNCATE THROUGH");
    },
  } as never;

  it("REFUSES to truncate the developer's database", async () => {
    // The failure this prevents is unrecoverable, so the test is explicit about
    // the exact URL a mistyped environment variable would produce.
    await expect(
      truncateAll(shouldNotBeUsed, "postgresql://signet:signet@127.0.0.1:5765/signet"),
    ).rejects.toThrow(/refusing to operate/i);
  });

  it("refuses anything not ending in _test, however close", async () => {
    for (const name of ["signet", "signet_testing", "test", "signet_test_backup", "prod"]) {
      await expect(
        truncateAll(shouldNotBeUsed, `postgresql://u:p@h:5432/${name}`),
        name,
      ).rejects.toThrow(/refusing to operate/i);
    }
  });

  it("names the database it refused, so the misconfiguration is findable", async () => {
    await expect(truncateAll(shouldNotBeUsed, "postgresql://u:p@h:5432/production")).rejects.toThrow(
      /"production"/,
    );
  });
});
