// Design-of-record store. One approved design per increment — the ground
// truth the conformance gate judges against, and a slice of it goes into the
// agent's context pack so the constraint is known BEFORE implementing (a gate
// that only tells you afterwards is a worse product).

import { randomUUID } from "node:crypto";
import {
  DesignOfRecordSchema,
  IncrementIdSchema,
  type DesignOfRecord,
} from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";

export class DesignStore {
  constructor(private readonly db: PrismaClient) {}

  async approve(incrementId: string, input: Omit<DesignOfRecord, "incrementId" | "approvedAt">): Promise<DesignOfRecord> {
    const incId = IncrementIdSchema.parse(incrementId);
    const record = DesignOfRecordSchema.parse({
      ...input,
      incrementId: incId,
      approvedAt: new Date().toISOString(),
    });
    await this.db.designRecord.upsert({
      where: { incrementId: incId },
      create: {
        id: randomUUID(),
        incrementId: incId,
        source: record.source,
        approvedBy: record.approvedBy,
        approvedAt: new Date(record.approvedAt),
        intentJson: JSON.stringify(record.intent),
        referenceImagePath: record.referenceImagePath ?? null,
      },
      update: {
        source: record.source,
        approvedBy: record.approvedBy,
        approvedAt: new Date(record.approvedAt),
        intentJson: JSON.stringify(record.intent),
        referenceImagePath: record.referenceImagePath ?? null,
      },
    });
    return record;
  }

  async get(incrementId: string): Promise<DesignOfRecord | null> {
    const row = await this.db.designRecord.findUnique({ where: { incrementId } });
    if (!row) return null;
    return DesignOfRecordSchema.parse({
      incrementId: IncrementIdSchema.parse(row.incrementId),
      source: row.source,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt.toISOString(),
      intent: JSON.parse(row.intentJson), // signet-policy-allow: raw-json-parse -- validated by DesignOfRecordSchema on this statement
      ...(row.referenceImagePath ? { referenceImagePath: row.referenceImagePath } : {}),
    });
  }

  /** The markdown slice that goes into the agent's context pack. */
  renderSlice(record: DesignOfRecord): string {
    const i = record.intent;
    const lines = [
      `# Design of record (approved by ${record.approvedBy})`,
      "",
      "These constraints are APPROVED and non-negotiable. The conformance gate",
      "checks your work against them; violating one blocks the merge.",
      "",
    ];
    if (i.palette.length) lines.push(`- **Allowed palette:** ${i.palette.join(", ")} (perceptual tolerance ΔE ${i.maxDeltaE})`);
    if (i.forbiddenColors.length) lines.push(`- **Forbidden colours:** ${i.forbiddenColors.join(", ")}`);
    if (i.requiredAssets.length) lines.push(`- **Required assets:** ${i.requiredAssets.join(", ")}`);
    if (i.forbiddenAssets.length) lines.push(`- **Forbidden assets:** ${i.forbiddenAssets.join(", ")}`);
    if (i.notes) lines.push(`- **Notes:** ${i.notes}`);
    lines.push(
      "",
      "If the brief asks for something these constraints forbid, the design of",
      "record wins — follow it and note the conflict in your result.",
    );
    return lines.join("\n") + "\n";
  }
}
