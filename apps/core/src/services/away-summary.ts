// What happened while you were away.
//
// A tool that works while you sleep owes you a morning page. Everything on it was
// already recorded — runs with their endings, questions, merges, routines, quota edges,
// spend — so this is a read over a window of time and nothing more. The window starts
// when the person last looked, which only their browser knows, so it is a parameter.
//
// One sentence it can always say, because of how Signet is built: nothing reached main
// without you. Merges only happen at a person's seal. The count is still computed from
// the record rather than asserted, so a merge that did happen in the window is shown.

import { AwayEventSchema, AwaySummarySchema, type AwaySummary } from "@signet/contracts";
import type { z } from "zod";

/** Before parsing: ids are plain strings until the schema brands them. */
type Draft = z.input<typeof AwayEventSchema>;
import type { PrismaClient } from "../persistence/generated/client.js";

const MAX_EVENTS = 40;

export class AwaySummaryService {
  constructor(private readonly db: PrismaClient) {}

  async summary(since: Date, until: Date = new Date()): Promise<AwaySummary> {
    const window = { gte: since, lte: until };
    const [runs, escalations, increments, routines, quotas, spend] = await Promise.all([
      this.db.run.findMany({
        where: { finishedAt: window },
        include: { increment: { select: { id: true, title: true, featureId: true, status: true, stateJson: true } } },
        orderBy: { finishedAt: "asc" },
      }),
      this.db.escalation.findMany({ where: { createdAt: window }, orderBy: { createdAt: "asc" } }),
      this.db.increment.findMany({
        select: { id: true, title: true, featureId: true, status: true, stateJson: true, orderIndex: true, updatedAt: true },
      }),
      this.db.workflowRun.findMany({
        where: { startedAt: window },
        include: { workflow: { select: { name: true } } },
        orderBy: { startedAt: "asc" },
      }),
      this.db.quotaWindow.findMany({
        where: { OR: [{ exhaustedAt: window }, { resetsAt: window }] },
        orderBy: { observedAt: "asc" },
      }),
      this.db.usageLedgerEntry.aggregate({ where: { recordedAt: window }, _sum: { costUsd: true }, _count: true }),
    ]);

    const byId = new Map(increments.map((i) => [i.id, i]));
    const events: Draft[] = [];

    for (const r of runs) {
      if (!r.finishedAt) continue;
      const inc = r.increment;
      const common = { at: r.finishedAt.toISOString(), featureId: inc.featureId, incrementId: inc.id };
      if (r.status === "SUCCEEDED") {
        events.push({
          ...common,
          kind: "built",
          text: `“${inc.title}” was built`,
          yours: inc.status === "AWAITING_SIGNATURE",
        });
      } else if (r.status === "FAILED") {
        events.push({ ...common, kind: "failed", text: `“${inc.title}” failed`, yours: inc.status === "FAILED" && !inc.stateJson.includes('"dismissedAt"') });
      }
    }
    for (const e of escalations) {
      const inc = byId.get(e.incrementId);
      if (!inc) continue;
      events.push({
        at: e.createdAt.toISOString(),
        kind: "question",
        text: `“${inc.title}” stopped to ask you something`,
        yours: e.status === "RAISED",
        featureId: inc.featureId,
        incrementId: inc.id,
      });
    }

    let merged = 0;
    for (const inc of increments) {
      if (inc.status !== "MERGED") continue;
      const st = JSON.parse(inc.stateJson) as { mergedAt?: string }; // signet-policy-allow: raw-json-parse -- narrow shape read; written by us
      if (!st.mergedAt) continue;
      const at = new Date(st.mergedAt);
      if (at < since || at > until) continue;
      merged += 1;
      events.push({
        at: at.toISOString(),
        kind: "merged",
        text: `You merged “${inc.title}”`,
        yours: false,
        featureId: inc.featureId,
        incrementId: inc.id,
      });
    }

    for (const w of routines) {
      events.push({
        at: w.startedAt.toISOString(),
        kind: "routine",
        text:
          w.status === "skipped"
            ? `“${w.workflow.name}” ran and found nothing to do`
            : w.status === "failed"
              ? `“${w.workflow.name}” ran and failed`
              : `“${w.workflow.name}” ran`,
        yours: false,
        featureId: null,
        incrementId: null,
      });
    }

    for (const q of quotas) {
      if (q.exhaustedAt && q.exhaustedAt >= since && q.exhaustedAt <= until) {
        events.push({ at: q.exhaustedAt.toISOString(), kind: "quota_out", text: "Your Claude quota ran out", yours: false, featureId: null, incrementId: null });
      }
      if (q.resetsAt && q.resetsAt >= since && q.resetsAt <= until) {
        events.push({ at: q.resetsAt.toISOString(), kind: "quota_back", text: "Your Claude quota came back", yours: false, featureId: null, incrementId: null });
      }
    }

    events.sort((a, b) => a.at.localeCompare(b.at));

    const waiting = {
      seal: increments.filter((i) => i.status === "AWAITING_SIGNATURE").length,
      initial: increments.filter((i) => i.status === "CONTEXT_READY").length,
      questions: increments.filter((i) => i.status === "ESCALATED").length,
    };

    return AwaySummarySchema.parse({
      since: since.toISOString(),
      until: until.toISOString(),
      events: events.slice(-MAX_EVENTS),
      waiting,
      merged,
      // null when nothing in the window had a price — an honest gap, not zero.
      spentUsd: spend._sum.costUsd === null ? (spend._count > 0 ? null : 0) : Number(spend._sum.costUsd),
      startWith: pickStart(increments),
    });
  }
}

/**
 * Where to begin: a seal that FINISHES a feature beats one that does not, because a
 * finished feature is worth more than three half-finished ones. Otherwise the oldest seal.
 */
function pickStart(
  increments: Array<{ id: string; title: string; featureId: string; status: string; updatedAt: Date }>,
): z.input<typeof AwaySummarySchema>["startWith"] {
  const awaiting = increments
    .filter((i) => i.status === "AWAITING_SIGNATURE")
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
  if (awaiting.length === 0) return null;
  const finishes = awaiting.find((a) =>
    increments.filter((i) => i.featureId === a.featureId && i.id !== a.id).every((i) => i.status === "MERGED"),
  );
  const pick = finishes ?? awaiting[0];
  if (!pick) return null;
  return {
    featureId: pick.featureId,
    incrementId: pick.id,
    title: pick.title,
    why: finishes ? "Sealing it finishes its feature." : "It has been waiting the longest.",
  };
}
