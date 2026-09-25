// Check: no package may weaken the shared strict tsconfig.
// Every workspace tsconfig must extend @signet/typescript-config, and may not
// override a guarded flag except through the documented allowlist below.

import { join } from "node:path";
import { listFiles, readText, rel, repoRoot } from "../lib.mjs";

const GUARDED_FLAGS = [
  "strict",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noFallthroughCasesInSwitch",
  "noImplicitReturns",
];

// Documented exceptions: package path prefix -> flags it may set to a weaker value, with the reason recorded here.
const ALLOWLIST = {
  "apps/core": {
    // Nest DI initializes fields via the container; strictPropertyInitialization cannot see it.
    strictPropertyInitialization: true,
  },
};

function stripJsonComments(text) {
  return text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

export default {
  name: "tsconfig-drift: no package weakens the shared strict base",
  async run() {
    const violations = [];
    const tsconfigs = (
      await Promise.all(
        ["apps", "packages", "tooling"].map((d) => listFiles(join(repoRoot, d), ["tsconfig.json"])),
      )
    ).flat();

    for (const file of tsconfigs) {
      const r = rel(file);
      if (r.includes("typescript-config")) continue; // the base itself
      let cfg;
      try {
        cfg = JSON.parse(stripJsonComments(await readText(file)));
      } catch {
        violations.push(`${r}: unparseable tsconfig`);
        continue;
      }
      if (!cfg.extends || !String(cfg.extends).includes("@signet/typescript-config")) {
        violations.push(`${r}: must extend @signet/typescript-config`);
        continue;
      }
      const opts = cfg.compilerOptions ?? {};
      const pkgPrefix = Object.keys(ALLOWLIST).find((p) => r.startsWith(p));
      const allowed = pkgPrefix ? ALLOWLIST[pkgPrefix] : {};
      for (const flag of GUARDED_FLAGS) {
        if (flag in opts && opts[flag] !== true) {
          violations.push(`${r}: weakens guarded flag "${flag}"`);
        }
      }
      for (const [flag, value] of Object.entries(opts)) {
        if (flag === "strictPropertyInitialization" && value === false && !allowed[flag]) {
          violations.push(`${r}: sets strictPropertyInitialization=false without allowlist entry`);
        }
      }
    }
    return { ok: violations.length === 0, violations };
  },
};
