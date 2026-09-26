// The request has to be readable back, with its history.
//
// It was write-only: you typed what you wanted built, every check was judged
// against it, and no screen could show it to you. When a step is blocked the first
// question is "what did I actually ask for?", and the console had no answer.
//
// Versions are the subtle part. Answering a question does not edit the request, it
// appends a version — so a step approved before you answered was built from
// different instructions, and the screen has to be able to say which.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../persistence/generated/client.js";
import { setupTestDatabase, truncateAll } from "../testing/test-db.js";
import { ConsoleViews } from "./console-views.js";

const ctx = await setupTestDatabase();
const enabled = ctx !== null;
const url = ctx?.url ?? "";
const d = enabled ? describe : describe.skip;

let db: PrismaClient;
let views: ConsoleViews;
const featureId = randomUUID();
const v1 = randomUUID();
const v2 = randomUUID();
const stepOld = randomUUID();
const stepNew = randomUUID();

beforeAll(async () => {
  if (!enabled) return;
  db = ctx!.db;
  views = new ConsoleViews(db);

  await db.feature.create({ data: { id: featureId, title: "brief-readback spec", stage: "IMPLEMENTING" } });
  await db.briefVersion.create({
    data: { id: v1, featureId, version: 1, contentMd: "Build the hero banner.\n\nUse the brand colour." },
  });
  await db.briefVersion.create({
    data: { id: v2, featureId, version: 2, contentMd: "Build the hero banner.\n\nUse the brand colour.\n\nAnswer: the headline is centred." },
  });
  // One step built before the answer, one after.
  for (const [id, briefVersionId, title, order] of [
    [stepOld, v1, "built earlier", 0],
    [stepNew, v2, "built later", 1],
  ] as const) {
    await db.increment.create({
      data: {
        id,
        featureId,
        title,
        status: "MERGED",
        stateJson: JSON.stringify({ status: "MERGED", mergedAt: new Date().toISOString() }),
        declaredSurface: ["hero.mjs"],
        briefVersionId,
        orderIndex: order,
      },
    });
  }
});

afterAll(async () => {
  if (!enabled) return;
  // Id-free and unconditional: a teardown that deletes remembered rows can
  // miss one, and missing one is how 22 test features ended up on the board.
  await truncateAll(db, url);
  await db.$disconnect();
});

d("reading the request back (live DB)", () => {
  it("returns what was written, verbatim", async () => {
    const detail = await views.featureDetail(featureId);
    // Exactly as typed — line breaks included, since the screen shows it as written.
    expect(detail.briefs[0]?.contentMd).toContain("Build the hero banner.");
    expect(detail.briefs[0]?.contentMd).toContain("\n\n");
  });

  it("puts the current version first, and keeps the earlier ones", async () => {
    const detail = await views.featureDetail(featureId);
    expect(detail.briefs.map((b) => b.version)).toEqual([2, 1]);
    // Nothing is overwritten: the original wording survives an answer.
    expect(detail.briefs[1]?.contentMd).not.toContain("Answer:");
  });

  it("records which version each step was built from", async () => {
    const detail = await views.featureDetail(featureId);
    const older = detail.increments.find((i) => i.title === "built earlier");
    const newer = detail.increments.find((i) => i.title === "built later");
    // This is what lets the screen say "built from version 1" on a step that ran
    // before you answered — and explain why it did not follow the later wording.
    expect(older?.briefVersionId).toBe(v1);
    expect(newer?.briefVersionId).toBe(v2);
    expect(older?.briefVersionId).not.toBe(detail.briefs[0]?.id);
  });
});
