// Check: structured logging only in production code.
// console.* is banned in apps/core/src and packages/contracts/src; the CLI
// entrypoints, tests, and tooling are exempt. Escape hatch: a reasoned
// signet-policy-allow comment on or above the line.

import { join } from "node:path";
import { listFiles, readText, rel, repoRoot, violatingLines } from "../lib.mjs";

const SCOPES = ["apps/core/src", "packages/contracts/src"];

export default {
  name: "no-console: structured logging only in core and contracts",
  async run() {
    const violations = [];
    for (const scope of SCOPES) {
      const files = await listFiles(join(repoRoot, scope), [".ts"]);
      for (const file of files) {
        const r = rel(file);
        if (r.endsWith(".spec.ts") || r.endsWith(".test.ts")) continue;
        if (r.endsWith("/main.ts")) continue; // bootstrap may report fatal startup errors
        const text = await readText(file);
        const lines = violatingLines(text, /\bconsole\.(log|warn|error|info|debug|trace)\s*\(/, "console");
        for (const ln of lines) violations.push(`${r}:${ln}: console.* in production code`);
      }
    }
    return { ok: violations.length === 0, violations };
  },
};
