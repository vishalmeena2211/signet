#!/usr/bin/env node
// @signet/policy — runs every repo invariant check and fails loudly on the first violation.
// Checks are added by the policy task; each lives in ./checks/ and exports
// { name, run(): Promise<{ ok: boolean; violations: string[] }> }.

import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const checksDir = join(dirname(fileURLToPath(import.meta.url)), "checks");

let entries = [];
try {
  entries = (await readdir(checksDir)).filter((f) => f.endsWith(".mjs")).sort();
} catch {
  // no checks directory yet
}

if (entries.length === 0) {
  console.log("policy: no checks registered yet (scaffold state)");
  process.exit(0);
}

let failed = false;
for (const entry of entries) {
  const mod = await import(join(checksDir, entry));
  const { name, run } = mod.default ?? mod;
  const result = await run();
  if (result.ok) {
    console.log(`✓ ${name}`);
  } else {
    failed = true;
    console.error(`✗ ${name}`);
    for (const v of result.violations) console.error(`    ${v}`);
  }
}

process.exit(failed ? 1 : 0);
