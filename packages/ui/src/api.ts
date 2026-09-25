// Typed console client — response shapes are the contracts schemas, parsed on
// arrival (parse, don't assume, on the client too).

import { z } from "zod";
import {
  ActivityViewSchema,
  EscalationViewSchema,
  FeatureSummarySchema,
  GateVerdictViewSchema,
  IncrementDetailSchema,
  QuotaStateViewSchema,
  type ActivityView,
  type CreateFeatureRequest,
  type EscalationView,
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
        activity: z.record(z.string(), ActivityViewSchema),
        escalations: z.array(EscalationViewSchema),
      }),
    ) as Promise<{
      feature: FeatureSummary;
      increments: IncrementDetail[];
      verdicts: Record<string, GateVerdictView[]>;
      activity: Record<string, ActivityView>;
      escalations: EscalationView[];
    }>,

  createFeature: async (req: CreateFeatureRequest): Promise<{ featureId: string }> => {
    const res = await fetch("/api/features", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`create failed: ${res.status}`);
    return z.object({ featureId: z.string() }).parse(await res.json());
  },

  answerEscalation: async (id: string, answer: string): Promise<void> => {
    const res = await fetch(`/api/escalations/${id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer }),
    });
    if (!res.ok) throw new Error(`answer failed: ${res.status}`);
  },

  approve: post("approve"),
  merge: post("merge"),
  retry: post("retry"),
  abort: post("abort"),
};

function post(action: string) {
  return async (incrementId: string): Promise<void> => {
    const res = await fetch(`/api/increments/${incrementId}/${action}`, { method: "POST" });
    if (!res.ok) throw new Error(`${action} failed: ${res.status}`);
  };
}
