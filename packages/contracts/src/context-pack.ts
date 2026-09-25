// The context pack: everything a worker is allowed to know, assembled
// deterministically by the master. The manifest is persisted per run so
// "what did it know?" always has an exact answer.

import { z } from "zod";
import { BriefVersionIdSchema, IncrementIdSchema } from "./ids.js";

export const ContextPackSectionSchema = z.object({
  name: z.enum([
    "brief_slice",
    "design_of_record_slice",
    "acceptance_criteria",
    "repo_map_neighbourhood",
    "confirmed_rules",
    "handoff_note",
  ]),
  contentHash: z.string().min(1), // sha256 of the rendered section
  bytes: z.number().int().min(0),
});
export type ContextPackSection = z.infer<typeof ContextPackSectionSchema>;

export const ContextPackManifestSchema = z.object({
  incrementId: IncrementIdSchema,
  briefVersionId: BriefVersionIdSchema,
  sections: z.array(ContextPackSectionSchema),
  declaredSurface: z.array(z.string().min(1)), // file paths/globs the plan may touch
  assembledAt: z.iso.datetime(),
  packHash: z.string().min(1), // sha256 over section hashes, order-stable
});
export type ContextPackManifest = z.infer<typeof ContextPackManifestSchema>;
