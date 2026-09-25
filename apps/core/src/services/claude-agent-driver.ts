// Bridges the ClaudeAdapter to the RunEngine's AgentDriver interface: builds
// the plan and implement prompts from the context pack, parses the plan JSON,
// threads repair feedback, resumes sessions across repairs.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  IncrementPlanSchema,
  nonRecoverable,
  type AdapterEvent,
  type ModelUsage,
  type SessionRef,
  type SignetError,
} from "@signet/contracts";
import { ClaudeAdapter, extractJsonBlock } from "../domain/adapter/claude-adapter.js";
import type { AgentDriver } from "./run-engine.js";

export interface ClaudeAgentDriverOptions {
  model?: string; // e.g. pin haiku for fixture-sized work; default = user's default
  maxTurns: number;
}

export class ClaudeAgentDriver implements AgentDriver {
  constructor(
    private readonly adapter: ClaudeAdapter,
    private readonly opts: ClaudeAgentDriverOptions,
  ) {}

  private async packSection(packDir: string, file: string): Promise<string> {
    try {
      return await readFile(join(packDir, file), "utf8");
    } catch {
      return "";
    }
  }

  async plan(input: { packDir: string; workspacePath: string }) {
    const brief = await this.packSection(input.packDir, "brief.md");
    const acceptance = await this.packSection(input.packDir, "acceptance.md");
    const surface = await this.packSection(input.packDir, "surface.txt");

    const prompt = [
      "You are planning ONE small implementation increment. Do not write any code yet.",
      "Read the brief and acceptance criteria, inspect the code if needed, then output",
      "ONLY a JSON object (no prose) of the shape:",
      '{ "approach": string, "filesToTouch": string[], "risks": string[] }',
      "filesToTouch must be paths relative to the repository root, and must stay inside",
      "the declared surface below. If the brief is ambiguous, list the ambiguity in risks.",
      "",
      "## Brief",
      brief,
      "## Acceptance criteria",
      acceptance,
      "## Declared surface (you may only touch files matching these)",
      surface,
    ].join("\n");

    const usage: ModelUsage[] = [];
    const result = await this.adapter.execute({
      workspacePath: input.workspacePath,
      prompt,
      maxTurns: Math.min(this.opts.maxTurns, 8),
      ...(this.opts.model !== undefined ? { model: this.opts.model } : {}),
      onEvent: async (ev: AdapterEvent) => {
        if (ev.type === "usage_update" || ev.type === "completed") usage.push(...ev.perModel);
      },
    });

    if (!result.ok || !result.sessionRef) {
      return { ok: false as const, error: result.error ?? nonRecoverable("plan.no_session", "no session") };
    }
    const candidate = extractJsonBlock(result.resultText);
    const parsed = IncrementPlanSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ok: false as const,
        error: {
          kind: "recoverable",
          code: "plan.unparseable",
          message: `plan output failed validation: ${parsed.error.issues[0]?.message ?? "bad shape"}`,
        } satisfies SignetError,
      };
    }
    return { ok: true as const, plan: parsed.data, sessionRef: result.sessionRef, usage };
  }

  async implement(input: {
    packDir: string;
    workspacePath: string;
    resumeSession: SessionRef | null;
    repairFeedback: string | null;
    onEvent: (ev: AdapterEvent) => Promise<void>;
  }) {
    let prompt: string;
    if (input.repairFeedback) {
      prompt = [
        "The gates rejected your previous attempt. Fix ONLY what the findings below",
        "describe, keeping within the declared surface. Findings:",
        "",
        input.repairFeedback,
      ].join("\n");
    } else {
      const brief = await this.packSection(input.packDir, "brief.md");
      const acceptance = await this.packSection(input.packDir, "acceptance.md");
      const surface = await this.packSection(input.packDir, "surface.txt");
      prompt = [
        "Implement this increment now, following your approved plan.",
        "Rules: touch only files inside the declared surface; write or update tests",
        "that FAIL without your change and PASS with it; do not touch existing tests",
        "except to keep them honest; make the project's test suite pass.",
        "",
        "## Brief",
        brief,
        "## Acceptance criteria",
        acceptance,
        "## Declared surface",
        surface,
      ].join("\n");
    }

    const result = await this.adapter.execute({
      workspacePath: input.workspacePath,
      prompt,
      resumeSession: input.resumeSession,
      maxTurns: this.opts.maxTurns,
      ...(this.opts.model !== undefined ? { model: this.opts.model } : {}),
      onEvent: input.onEvent,
    });

    if (!result.ok || !result.sessionRef) {
      return {
        ok: false as const,
        error: result.error ?? nonRecoverable("implement.no_session", "no session"),
      };
    }
    return { ok: true as const, sessionRef: result.sessionRef };
  }
}
