// Which language a repo is in, and what that means for checking it: how to run its
// tests, which files are tests, and what a test's declaration looks like.
//
// Every check used to assume JavaScript: `npm test` if there was a package.json, test
// files named *.test.js or *.spec.ts, tests declared with test( or it(. On a Python, Go
// or Rust repo the tests check was quietly skipped, so no promise could ever be proven
// and every seal was on trust, without the console saying why.

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export type EcosystemName = "node" | "python" | "go" | "rust";

export interface TestCommand {
  cmd: string;
  args: string[];
  /** As you would type it, for the console. */
  shown: string;
}

export interface Ecosystem {
  name: EcosystemName;
  /** How to run the whole suite, or null with the reason it cannot be run. */
  tests: TestCommand | { none: string };
}

const exists = (p: string): Promise<boolean> => access(p).then(
  () => true,
  () => false,
);

function command(cmd: string, args: string[]): TestCommand {
  return { cmd, args, shown: [cmd, ...args].join(" ") };
}

/** The first ecosystem the repo's own files declare. Null when none is recognised. */
export async function detectEcosystem(dir: string): Promise<Ecosystem | null> {
  if (await exists(join(dir, "package.json"))) {
    let script: string | undefined;
    let declared: string | undefined;
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string>; packageManager?: string }; // signet-policy-allow: raw-json-parse -- reading the repo's own package.json for two fields
      script = pkg.scripts?.["test"];
      declared = pkg.packageManager?.split("@")[0];
    } catch {
      return { name: "node", tests: { none: "package.json could not be read." } };
    }
    // npm's placeholder fails on purpose; running it would read as a broken suite every time.
    if (!script || /no test specified/.test(script)) {
      return { name: "node", tests: { none: "package.json has no test script." } };
    }
    // The manager the repo declares; failing that, npm whenever its lockfile is there. A
    // real repo carried both npm and pnpm lockfiles and a half-made pnpm workspace file,
    // and `pnpm test` refused to run in it while `npm test` ran fine.
    const manager =
      declared === "pnpm" || declared === "yarn" || declared === "npm"
        ? declared
        : (await exists(join(dir, "package-lock.json")))
          ? "npm"
          : (await exists(join(dir, "pnpm-lock.yaml")))
            ? "pnpm"
            : (await exists(join(dir, "yarn.lock")))
              ? "yarn"
              : "npm";
    return { name: "node", tests: command(manager, manager === "npm" ? ["test", "--silent"] : ["test"]) };
  }
  if ((await exists(join(dir, "pyproject.toml"))) || (await exists(join(dir, "setup.py"))) || (await exists(join(dir, "setup.cfg"))) || (await exists(join(dir, "pytest.ini")))) {
    // -p no:cacheprovider: no .pytest_cache left in the step's copy of the repo.
    return { name: "python", tests: command("python3", ["-m", "pytest", "-q", "-p", "no:cacheprovider"]) };
  }
  if (await exists(join(dir, "go.mod"))) return { name: "go", tests: command("go", ["test", "./..."]) };
  if (await exists(join(dir, "Cargo.toml"))) return { name: "rust", tests: command("cargo", ["test", "--quiet"]) };
  return null;
}

/**
 * Why a test command's failure is the machine's, not the code's: the runner itself is
 * missing. Worth telling apart, because no rewrite of the code can fix it and repairing
 * would spend a step's budget on nothing.
 */
export function runnerMissing(eco: EcosystemName, code: number, output: string): boolean {
  if (code === 127) return true;
  if (eco === "python") return /No module named pytest/.test(output);
  return false;
}

/**
 * pytest exits 5 when it collected nothing: a repo with no tests yet has a suite that
 * passes, not one that fails.
 */
export function suitePassed(eco: EcosystemName, code: number): boolean {
  return code === 0 || (eco === "python" && code === 5);
}

/** Test files, by the conventions of every ecosystem Signet runs. */
export function isTestFile(f: string): boolean {
  return (
    /\.(spec|test)\.(c|m)?[jt]sx?$/.test(f) || // javascript, typescript
    /(^|\/)__tests__\//.test(f) ||
    /(^|\/)test_[^/]*\.py$/.test(f) || // python
    f.endsWith("_test.py") ||
    f.endsWith("_test.go") || // go
    /(^|\/)tests\/[^/]+\.rs$/.test(f) || // rust integration tests
    /(^|\/)(tests?|spec)\/.*\.(c|m)?[jt]sx?$/.test(f) ||
    /(^|\/)tests\/.*\.py$/.test(f)
  );
}

/**
 * A line that declares a test, in any ecosystem Signet runs: test( / it( in JavaScript,
 * def test_… in Python, func Test… or a t.Run subtest in Go, fn … in Rust (the #[test]
 * attribute sits on the line above, so any fn counts, and the claimed name must match).
 */
export const TEST_DECLARATION = /^\s*(?:(?:test|it)(?:\.\w+)*\s*\(|(?:async\s+)?def\s+test_\w*\s*\(|func\s+Test\w*\s*\(|.*\bt\.Run\s*\(|(?:pub\s+)?(?:async\s+)?fn\s+\w+\s*\()/;
