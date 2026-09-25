// Conformance analyzer — does the built increment match the INTENDED design?
// Distinct from visual regression (which compares to the previous build) and
// from the rules gate (which enforces the learned constitution): this compares
// the change against a per-increment design-of-record the human approved.
//
// v1 deterministic path: check the diff's colors/assets against the design
// intent. VLM path (render + judge vs a reference image) is scaffolded behind
// an injected judge so it can land without a live renderer in the pilot.

import { deltaE, findColors } from "../learner/color.js";
import type { ConformanceDimension, ConformanceResult, DesignOfRecord } from "@signet/contracts";
import type { DiffLine } from "./rule-check.js";

export interface VlmJudge {
  /** Given a rendered screenshot path and the reference image, return 0..1 fidelity + notes. */
  judge(input: { builtImagePath: string; referenceImagePath: string; intentNotes?: string }): Promise<{
    score: number;
    notes: string;
  }>;
}

export interface ConformanceInput {
  design: DesignOfRecord;
  addedLines: DiffLine[];
  changedFiles: string[];
  builtImagePath?: string; // present only when a render is available (VLM path)
  vlm?: VlmJudge;
}

export async function analyzeConformance(input: ConformanceInput): Promise<ConformanceResult> {
  const { design, addedLines, changedFiles } = input;
  const dims: ConformanceDimension[] = [];
  const intent = design.intent;

  // ── palette conformance: new colors must be within ΔE of the approved palette ──
  // Explicitly-forbidden colors are the forbidden_color dimension's concern —
  // skip them here so each divergence is reported once, by the right dimension.
  if (intent.palette.length > 0) {
    const allowed = intent.palette.map((h) => h.toLowerCase());
    const forbidden = new Set(intent.forbiddenColors.map((h) => h.toLowerCase()));
    const offenders: string[] = [];
    for (const dl of addedLines) {
      for (const hit of findColors(dl.text)) {
        if (forbidden.has(hit.color.hex)) continue;
        const nearest = Math.min(...allowed.map((a) => deltaE(hit.color.hex, a)));
        if (nearest > intent.maxDeltaE) offenders.push(`${dl.file}:${dl.line} ${hit.raw} (ΔE ${Math.round(nearest)})`);
      }
    }
    dims.push({
      dimension: "palette",
      score: offenders.length === 0 ? 1 : Math.max(0, 1 - offenders.length / 10),
      passed: offenders.length === 0,
      detail:
        offenders.length === 0
          ? "all new colors are within the approved palette"
          : `${offenders.length} new color(s) diverge from the approved palette`,
      evidence: offenders.slice(0, 10),
    });
  }

  // ── forbidden colors ──
  if (intent.forbiddenColors.length > 0) {
    const forbidden = new Set(intent.forbiddenColors.map((h) => h.toLowerCase()));
    const hits: string[] = [];
    for (const dl of addedLines) {
      for (const c of findColors(dl.text)) {
        if (forbidden.has(c.color.hex)) hits.push(`${dl.file}:${dl.line} ${c.raw}`);
      }
    }
    dims.push({
      dimension: "forbidden_color",
      score: hits.length === 0 ? 1 : 0,
      passed: hits.length === 0,
      detail: hits.length === 0 ? "no forbidden colors introduced" : `${hits.length} forbidden color use(s)`,
      evidence: hits.slice(0, 10),
    });
  }

  // ── forbidden assets ──
  if (intent.forbiddenAssets.length > 0) {
    const hits: string[] = [];
    for (const asset of intent.forbiddenAssets) {
      const base = asset.split("/").pop() ?? asset;
      for (const dl of addedLines) if (dl.text.includes(base)) hits.push(`${dl.file}:${dl.line} → ${asset}`);
    }
    dims.push({
      dimension: "forbidden_asset",
      score: hits.length === 0 ? 1 : 0,
      passed: hits.length === 0,
      detail: hits.length === 0 ? "no forbidden assets referenced" : `${hits.length} forbidden asset reference(s)`,
      evidence: hits.slice(0, 10),
    });
  }

  // ── required assets: must appear somewhere in the changed surface ──
  if (intent.requiredAssets.length > 0) {
    const missing = intent.requiredAssets.filter((asset) => {
      const base = asset.split("/").pop() ?? asset;
      return !addedLines.some((dl) => dl.text.includes(base)) && !changedFiles.some((f) => f.includes(base));
    });
    dims.push({
      dimension: "required_asset",
      score: missing.length === 0 ? 1 : Math.max(0, 1 - missing.length / intent.requiredAssets.length),
      passed: missing.length === 0,
      detail: missing.length === 0 ? "all required assets present" : `missing required asset(s): ${missing.join(", ")}`,
      evidence: missing,
    });
  }

  // ── VLM judgment (only when a render + reference + judge are all available) ──
  if (input.builtImagePath && design.referenceImagePath && input.vlm) {
    const notes = intent.notes;
    const v = await input.vlm.judge({
      builtImagePath: input.builtImagePath,
      referenceImagePath: design.referenceImagePath,
      ...(notes !== undefined ? { intentNotes: notes } : {}),
    });
    dims.push({
      dimension: "vlm_judgment",
      score: v.score,
      passed: v.score >= 0.8,
      detail: v.notes,
      evidence: [],
    });
  }

  return {
    incrementId: design.incrementId,
    dimensions: dims,
    overallPassed: dims.every((d) => d.passed),
  };
}
