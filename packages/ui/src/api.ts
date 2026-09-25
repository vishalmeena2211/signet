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
  RuleCardSchema,
  type ActivityView,
  type CreateFeatureRequest,
  type EscalationView,
  type FeatureSummary,
  type GateVerdictView,
  type IncrementDetail,
  type QuotaStateView,
  type RuleCard,
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

  ruleQueue: (repo?: string): Promise<RuleCard[]> =>
    get(`/api/rules/queue${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, z.array(RuleCardSchema)),

  learn: async (repoPath: string): Promise<{ label: string; proposed: number; skipped: number }> => {
    const res = await fetch("/api/learn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath }),
    });
    if (!res.ok) throw new Error(`learn failed: ${res.status}`);
    return z.object({ label: z.string(), proposed: z.number(), skipped: z.number() }).parse(await res.json());
  },

  confirmRule: async (id: string): Promise<void> => {
    const res = await fetch(`/api/rules/${id}/confirm`, { method: "POST" });
    if (!res.ok) throw new Error(`confirm failed: ${res.status}`);
  },
  rejectRule: async (id: string): Promise<void> => {
    const res = await fetch(`/api/rules/${id}/reject`, { method: "POST" });
    if (!res.ok) throw new Error(`reject failed: ${res.status}`);
  },
  editRule: async (id: string, statement: string): Promise<void> => {
    const res = await fetch(`/api/rules/${id}/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement }),
    });
    if (!res.ok) throw new Error(`edit failed: ${res.status}`);
  },
};

function post(action: string) {
  return async (incrementId: string): Promise<void> => {
    const res = await fetch(`/api/increments/${incrementId}/${action}`, { method: "POST" });
    if (!res.ok) throw new Error(`${action} failed: ${res.status}`);
  };
}
