// Check: parse, don't assume, at every boundary.
// Raw JSON.parse is allowed ONLY inside packages/contracts (where results are
// immediately schema-validated) and *.cast.ts quarantine files. Everywhere else
// data entering the process must go through a contracts schema.

import { join } from "node:path";
import { listFiles, readText, rel, repoRoot, violatingLines } from "../lib.mjs";

export default {
  name: "contracts-only-parse: raw JSON.parse banned outside packages/contracts",
  async run() {
    const violations = [];
    const files = (
      await Promise.all(
        ["apps", "packages", "tooling"].map((d) => listFiles(join(repoRoot, d), [".ts", ".tsx"])),
      )
    ).flat();

    for (const file of files) {
      const r = rel(file);
      if (r.startsWith("packages/contracts/")) continue;
      if (r.endsWith(".cast.ts")) continue;
      if (r.includes("/test/") || r.endsWith(".spec.ts") || r.endsWith(".test.ts")) continue;
      const text = await readText(file);
      const lines = violatingLines(text, /JSON\.parse\s*\(/, "raw-json-parse");
      for (const ln of lines) violations.push(`${r}:${ln}: raw JSON.parse outside contracts`);
    }
    return { ok: violations.length === 0, violations };
  },
};
