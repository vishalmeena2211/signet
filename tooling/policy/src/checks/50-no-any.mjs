// Check: `any` is banned; type assertions are quarantined.
// - `: any`, `<any>`, `any[]`, `as any` fail everywhere except *.cast.ts files.
// - *.cast.ts is the named quarantine for unavoidable boundary assertions and
//   must carry a reason comment at the top of the file.
// oxlint also enforces no-explicit-any; this check is the belt to that braces —
// policy must not depend on a linter config someone can edit.

import { join } from "node:path";
import { listFiles, readText, rel, repoRoot, violatingLines } from "../lib.mjs";

const ANY_PATTERN = /(:\s*any\b|<any>|\bany\[\]|\bas\s+any\b)/;

export default {
  name: "no-any: `any` banned outside *.cast.ts quarantine",
  async run() {
    const violations = [];
    const files = (
      await Promise.all(
        ["apps/core/src", "packages/contracts/src", "packages/ui/src"].map((d) =>
          listFiles(join(repoRoot, d), [".ts", ".tsx"]),
        ),
      )
    ).flat();

    for (const file of files) {
      const r = rel(file);
      if (r.endsWith(".cast.ts")) {
        const text = await readText(file);
        if (!/^\/\/ signet-cast-quarantine:/.test(text)) {
          violations.push(`${r}: cast quarantine file missing its reason header comment`);
        }
        continue;
      }
      if (r.endsWith(".spec.ts") || r.endsWith(".test.ts")) continue;
      const text = await readText(file);
      const lines = violatingLines(text, ANY_PATTERN, "any");
      for (const ln of lines) violations.push(`${r}:${ln}: \`any\` outside quarantine`);
    }
    return { ok: violations.length === 0, violations };
  },
};
