// What happened to a feature, recorded as it happens.
//
// Runs, questions and request versions each carry their own times, but several things a
// feature's timeline needs were recorded nowhere: when it was asked for and in whose
// words, what was proposed, which commit a merge became, what was taken back. They are
// written here, and the thread reads them beside everything else.

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../persistence/generated/client.js";

export type FeatureEventKind = "asked" | "proposed" | "initialled" | "answered" | "sent_back" | "merged" | "taken_back" | "dismissed";

export class FeatureEvents {
  constructor(private readonly db: PrismaClient) {}

  async record(input: {
    featureId?: string;
    incrementId?: string | null;
    kind: FeatureEventKind;
    payload?: Record<string, unknown>;
    at?: Date;
  }): Promise<void> {
    let featureId = input.featureId;
    if (!featureId && input.incrementId) {
      const inc = await this.db.increment.findUnique({ where: { id: input.incrementId }, select: { featureId: true } });
      featureId = inc?.featureId;
    }
    if (!featureId) return;
    await this.db.featureEvent.create({
      data: {
        id: randomUUID(),
        featureId,
        incrementId: input.incrementId ?? null,
        kind: input.kind,
        ...(input.at ? { at: input.at } : {}),
        payloadJson: JSON.stringify(input.payload ?? {}),
      },
    });
  }
}

/** A tiny registry of proposals being worked out right now — the canal's first reach. */
export class ProposalsInFlight {
  private readonly items = new Map<string, { goal: string; repoLabel: string; startedAt: Date }>();

  begin(goal: string, repoLabel: string): () => void {
    const id = randomUUID();
    this.items.set(id, { goal, repoLabel, startedAt: new Date() });
    return () => this.items.delete(id);
  }

  list(): Array<{ goal: string; repoLabel: string; startedAt: Date }> {
    return [...this.items.values()];
  }
}
