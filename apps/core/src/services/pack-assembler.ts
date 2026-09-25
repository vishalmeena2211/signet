// Context pack assembler v0 — deterministic: renders the increment's brief
// slice, acceptance criteria, and declared surface into a pack directory, and
// persists the manifest (section hashes + pack hash) so "what did it know?"
// always has an exact answer.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BriefVersionIdSchema,
  ContextPackManifestSchema,
  type ContextPackManifest,
  type ContextPackSection,
  type IncrementId,
  type RunId,
} from "@signet/contracts";
import type { UnitOfWork } from "../domain/runtime/ports.js";
import type { PackAssembler } from "./run-engine.js";

export interface PackSources {
  loadIncrement: (id: IncrementId) => Promise<{
    title: string;
    declaredSurface: string[];
    briefVersionId: string;
    briefContentMd: string;
    acceptanceMd: string;
    handoffNote: string | null;
    /** Rendered design-of-record slice — the approved constraints, known BEFORE implementing. */
    designSliceMd: string | null;
  }>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class PackAssemblerV0 implements PackAssembler {
  constructor(
    private readonly packsRoot: string,
    private readonly sources: PackSources,
    private readonly uow: UnitOfWork,
  ) {}

  async assemble(input: { incrementId: IncrementId; runId: RunId; workspacePath: string | null }) {
    const inc = await this.sources.loadIncrement(input.incrementId);
    const packDir = join(this.packsRoot, `run-${input.runId}`);
    await mkdir(packDir, { recursive: true });

    const files: Array<{ name: ContextPackSection["name"]; file: string; content: string }> = [
      { name: "brief_slice", file: "brief.md", content: `# ${inc.title}\n\n${inc.briefContentMd}\n` },
      { name: "acceptance_criteria", file: "acceptance.md", content: inc.acceptanceMd },
      {
        name: "repo_map_neighbourhood",
        file: "surface.txt",
        content: inc.declaredSurface.join("\n") + "\n",
      },
      ...(inc.designSliceMd !== null
        ? [{ name: "design_of_record_slice" as const, file: "design.md", content: inc.designSliceMd }]
        : []),
      ...(inc.handoffNote !== null
        ? [{ name: "handoff_note" as const, file: "handoff.md", content: inc.handoffNote }]
        : []),
    ];

    const sections: ContextPackSection[] = [];
    for (const f of files) {
      await writeFile(join(packDir, f.file), f.content, "utf8");
      sections.push({ name: f.name, contentHash: sha256(f.content), bytes: Buffer.byteLength(f.content) });
    }

    const manifest: ContextPackManifest = ContextPackManifestSchema.parse({
      incrementId: input.incrementId,
      briefVersionId: BriefVersionIdSchema.parse(inc.briefVersionId),
      sections,
      declaredSurface: inc.declaredSurface,
      assembledAt: new Date().toISOString(),
      packHash: sha256(sections.map((s) => `${s.name}:${s.contentHash}`).join("|")),
    });
    await this.uow.run(async (tx) => {
      await tx.runs.saveManifest(input.runId, manifest);
    });

    return { packDir, declaredSurface: inc.declaredSurface };
  }
}
