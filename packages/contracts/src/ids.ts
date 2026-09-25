// Branded ID types. Passing a RunId where an IncrementId belongs is a compile
// error, not an incident. Runtime shape is a UUID string; the brand exists only
// in the type system. Constructors validate through zod.

import { z } from "zod";

export declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

const uuid = z.uuid();

function idSchema<B extends string>(name: B) {
  return uuid.transform((v) => v as Brand<string, B>).brand(name);
}

export const FeatureIdSchema = idSchema("FeatureId");
export const IncrementIdSchema = idSchema("IncrementId");
export const RunIdSchema = idSchema("RunId");
export const RunPhaseIdSchema = idSchema("RunPhaseId");
export const BriefVersionIdSchema = idSchema("BriefVersionId");
export const DesignRecordIdSchema = idSchema("DesignRecordId");
export const RuleIdSchema = idSchema("RuleId");
export const GateVerdictIdSchema = idSchema("GateVerdictId");
export const EscalationIdSchema = idSchema("EscalationId");
export const QuotaWindowIdSchema = idSchema("QuotaWindowId");
export const EffectIdSchema = idSchema("EffectId");
export const WorkspaceIdSchema = idSchema("WorkspaceId");
export const SessionRefSchema = z
  .string()
  .min(1)
  .transform((v) => v as Brand<string, "SessionRef">)
  .brand("SessionRef");

export type FeatureId = z.infer<typeof FeatureIdSchema>;
export type IncrementId = z.infer<typeof IncrementIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type RunPhaseId = z.infer<typeof RunPhaseIdSchema>;
export type BriefVersionId = z.infer<typeof BriefVersionIdSchema>;
export type DesignRecordId = z.infer<typeof DesignRecordIdSchema>;
export type RuleId = z.infer<typeof RuleIdSchema>;
export type GateVerdictId = z.infer<typeof GateVerdictIdSchema>;
export type EscalationId = z.infer<typeof EscalationIdSchema>;
export type QuotaWindowId = z.infer<typeof QuotaWindowIdSchema>;
export type EffectId = z.infer<typeof EffectIdSchema>;
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type SessionRef = z.infer<typeof SessionRefSchema>;
