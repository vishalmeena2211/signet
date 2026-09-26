#!/usr/bin/env node
// Removes the features that the automated tests create, and nothing else.
//
// The e2e and crash-replay suites seed features against the live development
// database, so after a few runs the board is dominated by rows titled "itest
// feature" — all sitting in the needs-you queue, which makes the console look
// broken and buries real work.
//
// It matches on the exact titles the tests use, prints what it will delete, and
// deletes children before parents so no foreign key is ever violated. It will not
// touch anything it did not recognise: an unknown title is left alone rather than
// guessed at.

import { PrismaPg } from "@prisma/adapter-pg";
// From dist, not src: at runtime the generated client under src/ is TypeScript.
// The sibling scripts do the same; this one was written against src by mistake
// and failed the moment it was first run.
import { PrismaClient } from "../dist/persistence/generated/client.js";

/** Exactly the titles seeded by the test suites. Deliberately not a pattern. */
const TEST_TITLES = [
  "itest feature",
  "crash test",
  "Add shout()",
  "Add whisper()",
  "e2e-fixture",
  // gate-story.spec fixtures
  "gs: repaired",
  "gs: blocked",
  "gs: clean",
  "gs: mixed",
];

const url = process.env.SIGNET_DATABASE_URL;
if (!url) {
  console.error("SIGNET_DATABASE_URL is required.");
  process.exit(1);
}

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

const features = await db.feature.findMany({
  where: { title: { in: TEST_TITLES } },
  include: { increments: { select: { id: true } } },
});

if (features.length === 0) {
  console.log("Nothing to prune — no test-seeded features found.");
  await db.$disconnect();
  process.exit(0);
}

const incrementIds = features.flatMap((f) => f.increments.map((i) => i.id));
const runs = await db.run.findMany({ where: { incrementId: { in: incrementIds } }, select: { id: true } });
const runIds = runs.map((r) => r.id);

console.log(`Pruning ${features.length} test features, ${incrementIds.length} increments, ${runIds.length} runs:`);
for (const f of features) console.log(`  · ${f.title} (${f.increments.length} increments)`);

// Children first, in dependency order.
await db.gateVerdict.deleteMany({ where: { runId: { in: runIds } } });
await db.usageLedgerEntry.deleteMany({ where: { runId: { in: runIds } } });
await db.runPhase.deleteMany({ where: { runId: { in: runIds } } });
await db.effect.deleteMany({ where: { runId: { in: runIds } } });
await db.contextPackManifest.deleteMany({ where: { runId: { in: runIds } } });
await db.run.deleteMany({ where: { id: { in: runIds } } });
await db.escalation.deleteMany({ where: { incrementId: { in: incrementIds } } });
await db.designRecord.deleteMany({ where: { incrementId: { in: incrementIds } } });
await db.increment.deleteMany({ where: { id: { in: incrementIds } } });
await db.briefVersion.deleteMany({ where: { featureId: { in: features.map((f) => f.id) } } });
await db.feature.deleteMany({ where: { id: { in: features.map((f) => f.id) } } });

console.log("Done. Real work is untouched.");
await db.$disconnect();
