// Typed console client — response shapes are the contracts schemas, parsed on
// arrival (parse, don't assume, on the client too).

import { z } from "zod";
import {
  FeatureSummarySchema,
  GateVerdictViewSchema,
  IncrementDetailSchema,
  QuotaStateViewSchema,
  type FeatureSummary,
  type GateVerdictView,
  type IncrementDetail,
  type QuotaStateView,
} from "@signet/contracts";

async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return schema.parse(await res.json());
}

export const api = {
  health: () =>
    get("/api/health", z.object({ ok: z.boolean(), quota: QuotaStateViewSchema })) as Promise<{
      ok: boolean;
      quota: QuotaStateView;
    }>,

  features: (): Promise<FeatureSummary[]> => get("/api/features", z.array(FeatureSummarySchema)),

  feature: (id: string) =>
    get(
      `/api/features/${id}`,
      z.object({
        feature: FeatureSummarySchema,
        increments: z.array(IncrementDetailSchema),
        verdicts: z.record(z.string(), z.array(GateVerdictViewSchema)),
      }),
    ) as Promise<{
      feature: FeatureSummary;
      increments: IncrementDetail[];
      verdicts: Record<string, GateVerdictView[]>;
    }>,

  approve: async (incrementId: string): Promise<void> => {
    const res = await fetch(`/api/increments/${incrementId}/approve`, { method: "POST" });
    if (!res.ok) throw new Error(`approve failed: ${res.status}`);
  },

  merge: async (incrementId: string): Promise<void> => {
    const res = await fetch(`/api/increments/${incrementId}/merge`, { method: "POST" });
    if (!res.ok) throw new Error(`merge failed: ${res.status}`);
  },
};
