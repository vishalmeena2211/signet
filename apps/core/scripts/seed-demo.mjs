#!/usr/bin/env node
// Demo seed: creates (or reuses) a demo target repo + one feature with one
// CONTEXT_READY increment, so the console has something real to approve.
// Usage: SIGNET_DATABASE_URL=... node scripts/seed-demo.mjs [targetRepoDir]

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../dist/persistence/generated/client.js";

const pexec = promisify(execFile);
const url = process.env.SIGNET_DATABASE_URL;
if (!url) {
  console.error("SIGNET_DATABASE_URL required");
  process.exit(1);
}

const repo = process.argv[2] ?? join(homedir(), ".signet", "demo-repo");
const g = (args) => pexec("git", ["-c", "user.name=demo", "-c", "user.email=demo@local", ...args], { cwd: repo });

const exists = await access(join(repo, ".git")).then(() => true).catch(() => false);
if (!exists) {
  await mkdir(repo, { recursive: true });
  await g(["init", "-b", "main"]).catch(async () => {
    await pexec("git", ["init", "-b", "main"], { cwd: repo });
  });
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ name: "signet-demo", private: true, type: "module", scripts: { test: "node run-tests.mjs" } }, null, 2),
  );
  await writeFile(
    join(repo, "run-tests.mjs"),
    `import { readdir } from "node:fs/promises";
const files = (await readdir(".")).filter((f) => f.endsWith(".test.mjs"));
let failed = 0;
for (const f of files) {
  try { await import("./" + f); console.log("ok " + f); }
  catch (e) { failed++; console.error("FAIL " + f + ": " + e.message); }
}
process.exit(failed === 0 ? 0 : 1);
`,
  );
  await writeFile(join(repo, "cart.mjs"), `export const total = (items) => items.reduce((s, i) => s + i.price, 0);\n`);
  await writeFile(
    join(repo, "cart.test.mjs"),
    `import { total } from "./cart.mjs";
if (total([{ price: 2 }, { price: 3 }]) !== 5) throw new Error("total broken");
`,
  );
  await g(["add", "-A"]);
  await g(["commit", "-m", "base"]);
  console.log("demo repo created:", repo);
} else {
  console.log("demo repo exists:", repo);
}

const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
const featureId = randomUUID();
const briefId = randomUUID();
const incId = randomUUID();
await client.feature.create({ data: { id: featureId, title: "Cart: discount support", stage: "IMPLEMENTING" } });
await client.briefVersion.create({
  data: {
    id: briefId,
    featureId,
    version: 1,
    contentMd:
      "Add `withDiscount(items, percent)` to cart.mjs: returns the total after applying a percentage discount, rounded to 2 decimals. Example: withDiscount([{price:100}], 10) === 90. Include a test that fails without the change. Do not modify existing functions.",
  },
});
await client.increment.create({
  data: {
    id: incId,
    featureId,
    title: "Add withDiscount()",
    status: "CONTEXT_READY",
    stateJson: JSON.stringify({ status: "CONTEXT_READY" }),
    declaredSurface: ["cart.mjs", "*.test.mjs"],
    briefVersionId: briefId,
    orderIndex: 0,
  },
});
await client.$disconnect();
console.log("seeded feature:", featureId);
console.log("increment:", incId);
console.log("target repo:", repo);
