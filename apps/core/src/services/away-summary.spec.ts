// The morning page: a read over a window of time.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../persistence/generated/client.js";
import { setupTestDatabase, truncateAll } from "../testing/test-db.js";
import { AwaySummaryService } from "./away-summary.js";

const ctx = await setupTestDatabase("away");
const enabled = ctx !== null;
const d = enabled ? describe : describe.skip;
let db: PrismaClient;

const SINCE = new Date("2026-09-28T18:10:00.000Z");
const UNTIL = new Date("2026-09-29T09:02:00.000Z");
const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  if (!enabled) return;
  db = ctx!.db;
  await truncateAll(db, ctx!.url);
  const f1 = randomUUID();
  const f2 = randomUUID();
  const brief1 = randomUUID();
  const brief2 = randomUUID();
  await db.feature.create({ data: { id: f1, title: "Cluster markers", stage: "IMPLEMENTING" } });
  await db.feature.create({ data: { id: f2, title: "Tiles", stage: "IMPLEMENTING" } });
  await db.briefVersion.create({ data: { id: brief1, featureId: f1, version: 1, contentMd: "x" } });
  await db.briefVersion.create({ data: { id: brief2, featureId: f2, version: 1, contentMd: "y" } });

  const inc = async (featureId: string, briefVersionId: string, title: string, status: string, state: object, order: number, updatedAt: Date) => {
    const id = randomUUID();
    await db.increment.create({
      data: { id, featureId, title, status, stateJson: JSON.stringify(state), declaredSurface: ["a"], briefVersionId, orderIndex: order },
    });
    await db.$executeRawUnsafe(`UPDATE increments SET updated_at = $1 WHERE id = $2::uuid`, updatedAt, id);
    return id;
  };
  const helper = await inc(f1, brief1, "Add a clustering helper", "MERGED", { status: "MERGED", mergedAt: "2026-09-28T15:03:00.000Z" }, 0, at("2026-09-28T15:03:00Z"));
  void helper;
  const option = await inc(f1, brief1, "Expose a clusterRadius option", "AWAITING_SIGNATURE", { status: "AWAITING_SIGNATURE", runId: randomUUID() }, 1, at("2026-09-28T19:05:00Z"));
  const tiles = await inc(f2, brief2, "Handle 404 tiles", "AWAITING_SIGNATURE", { status: "AWAITING_SIGNATURE", runId: randomUUID() }, 0, at("2026-09-28T18:50:00Z"));
  const other = await inc(f2, brief2, "Retina tiles", "CONTEXT_READY", { status: "CONTEXT_READY" }, 1, at("2026-09-28T12:00:00Z"));
  void other;

  await db.run.create({ data: { id: randomUUID(), incrementId: option, status: "SUCCEEDED", stateJson: "{}", startedAt: at("2026-09-28T18:45:00Z"), finishedAt: at("2026-09-28T19:05:00Z") } });
  await db.run.create({ data: { id: randomUUID(), incrementId: tiles, status: "SUCCEEDED", stateJson: "{}", startedAt: at("2026-09-28T18:20:00Z"), finishedAt: at("2026-09-28T18:50:00Z") } });
  // Outside the window: not reported.
  await db.run.create({ data: { id: randomUUID(), incrementId: helper, status: "SUCCEEDED", stateJson: "{}", startedAt: at("2026-09-28T14:58:00Z"), finishedAt: at("2026-09-28T15:01:00Z") } });
  await db.quotaWindow.create({ data: { id: randomUUID(), kind: "five_hour", exhaustedAt: at("2026-09-28T13:40:00Z"), resetsAt: at("2026-09-28T18:40:00Z") } });
});
afterAll(async () => {
  if (!enabled) return;
  await truncateAll(db, ctx!.url);
  await db.$disconnect();
});

d("while you were away (live DB)", () => {
  it("tells the night in order, marks what needs you, and counts what waits", async () => {
    const s = await new AwaySummaryService(db).summary(SINCE, UNTIL);
    expect(s.events.map((e) => [e.kind, e.text, e.yours])).toEqual([
      ["quota_back", "Your Claude quota came back", false],
      ["built", "“Handle 404 tiles” was built", true],
      ["built", "“Expose a clusterRadius option” was built", true],
    ]);
    expect(s.waiting).toEqual({ seal: 2, initial: 1, questions: 0 });
    expect(s.merged).toBe(0);
  });

  it("starts with the seal that finishes a feature, not merely the oldest", async () => {
    // "Handle 404 tiles" has waited longer, but sealing "Expose a clusterRadius option"
    // completes its feature; the tiles feature still has a step to go.
    const s = await new AwaySummaryService(db).summary(SINCE, UNTIL);
    expect(s.startWith).toMatchObject({ title: "Expose a clusterRadius option", why: "Sealing it finishes its feature." });
  });
});
