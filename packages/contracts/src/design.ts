// Design of record — the single approved design artifact a feature is built
// against. Two provenances: ingested (customer gave a Figma/screenshot/mock) or
// resolved (we generated a wireframe and a human approved it). The conformance
// gate judges the built increment against this.

import { z } from "zod";
import { IncrementIdSchema } from "./ids.js";

export const DesignSourceSchema = z.enum(["ingested", "resolved"]);
export type DesignSource = z.infer<typeof DesignSourceSchema>;

// A design-of-record for v1 (source-only pilot): the design intent expressed as
// constraints the deterministic path can check without a live render —
// required palette, forbidden colors, required/forbidden assets, plus an
// optional reference image path for the VLM path (scaffolded).
export const DesignOfRecordSchema = z.object({
  incrementId: IncrementIdSchema,
  source: DesignSourceSchema,
  approvedBy: z.string(),
  approvedAt: z.iso.datetime(),
  intent: z.object({
    palette: z.array(z.string()).default([]), // allowed brand/token hexes
    maxDeltaE: z.number().default(8),
    forbiddenColors: z.array(z.string()).default([]),
    requiredAssets: z.array(z.string()).default([]),
    forbiddenAssets: z.array(z.string()).default([]),
    notes: z.string().optional(),
  }),
  referenceImagePath: z.string().optional(), // for the VLM conformance path
});
export type DesignOfRecord = z.infer<typeof DesignOfRecordSchema>;

export const ApproveDesignRequestSchema = z.object({
  source: DesignSourceSchema,
  approvedBy: z.string().min(1),
  intent: DesignOfRecordSchema.shape.intent,
  referenceImagePath: z.string().optional(),
});
export type ApproveDesignRequest = z.infer<typeof ApproveDesignRequestSchema>;

// Per-dimension conformance result — never collapsed to one number
// (Design2Code lesson: keep the diagnostics visible).
export const ConformanceDimensionSchema = z.object({
  dimension: z.enum(["palette", "forbidden_color", "required_asset", "forbidden_asset", "vlm_judgment"]),
  score: z.number().min(0).max(1), // 1 = fully conformant
  passed: z.boolean(),
  detail: z.string(),
  evidence: z.array(z.string()).default([]),
});
export type ConformanceDimension = z.infer<typeof ConformanceDimensionSchema>;

export const ConformanceResultSchema = z.object({
  incrementId: IncrementIdSchema,
  dimensions: z.array(ConformanceDimensionSchema),
  overallPassed: z.boolean(),
});
export type ConformanceResult = z.infer<typeof ConformanceResultSchema>;
