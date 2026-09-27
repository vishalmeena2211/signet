// Proposing the breakdown, instead of demanding the user already know it.
//
// Feature creation used to ask for the steps AND the file globs each step was allowed
// to touch. Only somebody who already knows the codebase can answer that, and being
// wrong is unforgiving: a plan touching a file outside its declared surface is a
// NON-recoverable error, so the run dies with no repair attempt. Two of the four items
// in the pilot's attention queue were that exact failure —
//
//   · "Add withDiscount()" — the agent returned an empty file list.
//   · "do whatever"        — the agent needed cart.mjs; the hand-written surface
//                            disagreed, and the run was killed.
//
// Both times the agent knew what the work needed and the human's guess did not match.
// So the guessing moves to the side holding the repository.
//
// The surfaces do NOT go away. They are what catches an agent editing outside its
// remit, and removing the constraint to avoid the friction would be throwing away the
// guard rather than fixing the ergonomics. They stop being the user's homework and
// become a proposal the user reviews.
//
// Two things this deliberately does not do:
//
//   · It does not create anything. A proposal is a suggestion; nothing is persisted
//     until the user approves it, so a bad proposal costs one model call and no rows.
//   · It does not trust its own output. Every proposed glob is checked against files
//     that actually exist, and a glob matching nothing is reported rather than passed
//     through. That single check is the difference between a plan that reads well and
//     a plan that produces a dead run.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ValidatedFeatureProposalSchema,
  ProposeFeatureRequestSchema,
  nonRecoverable,
  type FeatureProposal,
  type FeatureProposalResponse,
  type ProposeFeatureRequest,
  type SignetError,
  type SurfaceWarning,
} from "@signet/contracts";
import { extractJsonBlock } from "../domain/adapter/claude-adapter.js";
import { profileRepo, renderProfile, type RepoProfile } from "../domain/learner/repo-profiler.js";
import { compileSurfacePattern } from "../domain/pipeline/scope-checker.js";

/** Just enough of the agent driver's adapter to ask one question. */
export interface ProposerAdapter {
  execute(input: {
    workspacePath: string;
    prompt: string;
    maxTurns: number;
    model?: string;
    signal?: AbortSignal;
    // `null` rather than optional, matching the adapter: it always reports an error
    // field and uses null for "there wasn't one". Declaring it optional here made the
    // two shapes silently incompatible.
  }): Promise<{ ok: boolean; resultText: string; error?: SignetError | null }>;
}

export interface ProposerDeps {
  adapter: ProposerAdapter;
  /**
   * The repository used when a request does not name one. A feature can target its own
   * repo now, so this is the fallback rather than the only answer.
   */
  targetRepoPath: string;
  /**
   * Turns whatever the picker sent into a local path to survey. For a github repo this
   * clones into the connector's existing shallow cache — the proposal needs the code,
   * and there is no point fetching anything until somebody actually asks.
   */
  resolveRepo?: (repoId: string | undefined) => Promise<{ path: string; label: string; origin: "local" | "github" }>;
  model?: string;
  maxTurns?: number;
}

/**
 * Checks every proposed surface against the files the survey actually found.
 *
 * The reason this exists: a glob that matches nothing looks completely reasonable on
 * screen. `src/cart/**` is a perfectly sensible surface for a repo that keeps cart.mjs
 * at the root, and it will produce either an empty plan or a scope violation. Finding
 * that out before the user signs costs nothing; finding out afterwards costs a run.
 */
export function checkSurfaces(proposal: FeatureProposal, profile: RepoProfile): SurfaceWarning[] {
  const warnings: SurfaceWarning[] = [];
  const paths = profile.files.map((f) => f.path);

  for (const step of proposal.steps) {
    for (const pattern of step.declaredSurface) {
      if (pattern.startsWith("/") || pattern.includes("..")) {
        warnings.push({ stepTitle: step.title, pattern, reason: "outside_repo" });
        continue;
      }
      // A bare ** hands the agent the entire repository, which is the same as having
      // no surface at all — the guard is nominally present and enforcing nothing.
      if (pattern === "**" || pattern === "**/*" || pattern === "*") {
        warnings.push({ stepTitle: step.title, pattern, reason: "matches_everything" });
        continue;
      }
      const re = compileSurfacePattern(pattern);
      // A brand new file legitimately does not exist yet, so an exact path that looks
      // like a file inside a directory the repo HAS is allowed through: the proposal is
      // permitted to invent `cart.test.mjs` next to `cart.mjs`. What is not allowed is
      // a pattern pointing into a directory that does not exist at all.
      const matchesExisting = paths.some((p) => re.test(p));
      if (matchesExisting) continue;

      const dir = pattern.includes("/") ? pattern.slice(0, pattern.lastIndexOf("/")) : "";
      const dirExists =
        dir === "" ||
        profile.directories.some((d) => d.path === dir || d.path.startsWith(`${dir}/`));
      // A new file must at least LOOK like a file. Without this, any bare word passes
      // as "a file that does not exist yet" — which is precisely how the pilot's
      // "do whatever" step got the surface `anything` and was killed on its first run.
      // The user was asked to invent a glob, typed a reasonable-sounding word, and the
      // system accepted it and then refused to work.
      const basename = pattern.slice(pattern.lastIndexOf("/") + 1);
      const looksLikeAFile = basename.includes(".") && !basename.endsWith(".");
      const isConcretePath = !pattern.includes("*");
      if (isConcretePath && dirExists && looksLikeAFile) continue;

      warnings.push({ stepTitle: step.title, pattern, reason: "matches_nothing" });
    }
  }
  return warnings;
}

function buildPrompt(goal: string, profileText: string): string {
  return [
    "You are breaking a request down into an ordered sequence of pull-request-sized steps",
    "for a codebase you have just been shown. You are NOT writing any code.",
    "",
    "Output ONLY a JSON object, no prose, of this exact shape:",
    "{",
    '  "title": string,',
    '  "understanding": string,',
    '  "steps": [{ "title": string, "rationale": string, "declaredSurface": string[], "acceptanceMd": string }],',
    '  "noWorkNeeded": string | null,',
    '  "uncertainties": string[]',
    "}",
    "",
    "IF THERE IS NOTHING TO DO, SAY SO. Return steps as [] and put the reason in",
    "noWorkNeeded. A request like \"add tests to any module missing them\" against a repo",
    "where every module already has tests has one correct answer, and it is an empty list.",
    "Never invent work to avoid returning nothing.",
    "",
    "Rules that matter more than elegance:",
    "",
    "1. declaredSurface is a HARD boundary, not a hint. The step will be killed outright",
    "   if its implementation touches a file outside it, with no chance to recover. So",
    "   list every file the step will need, including the test file and any file it must",
    "   read-and-edit. Prefer naming concrete files over broad globs.",
    "2. Use paths that exist in the survey below, or new files that sit beside existing",
    "   ones. A surface matching nothing is worse than a surface that is too wide.",
    "3. Follow the repository's own test-naming convention exactly as reported. Inventing",
    "   a different one produces a file the repo cannot run.",
    "4. Each step must be independently mergeable — it leaves the repo working. If two",
    "   pieces of work cannot be merged separately, they are one step, not two.",
    "5. acceptanceMd states what done means specifically enough to check. Not 'works',",
    "   but the observable behaviour, including edge cases the request implies.",
    "6. Prefer FEWER steps. Two solid steps beat five speculative ones. One step is a",
    "   perfectly good answer for a small request.",
    "7. Put anything you are guessing in uncertainties. A guess recorded there is useful;",
    "   the same guess buried silently in a surface is how runs die.",
    "8. Returning no steps is a real answer, not a failure. Prefer it over a step you do",
    "   not believe in.",
    "",
    "## What the user wants built",
    goal,
    "",
    profileText,
  ].join("\n");
}

export class FeatureProposer {
  constructor(private readonly deps: ProposerDeps) {}

  /**
   * Surveys the repo, asks for a breakdown, and validates it. Returns a typed error
   * rather than throwing, so the HTTP layer can map it and the caller can show the
   * reason instead of a generic failure.
   */
  async propose(
    input: ProposeFeatureRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ ok: true; response: FeatureProposalResponse } | { ok: false; error: SignetError }> {
    const req = ProposeFeatureRequestSchema.parse(input);

    const repo = this.deps.resolveRepo
      ? await this.deps.resolveRepo(req.repoId)
      : { path: this.deps.targetRepoPath, label: this.deps.targetRepoPath, origin: "local" as const };

    const profile = await profileRepo(repo.path);
    if (profile.files.length === 0) {
      // Refusing beats proposing. A breakdown derived from a repo we could not read
      // is fiction, and it would be indistinguishable on screen from a real one.
      return {
        ok: false,
        error: nonRecoverable(
          "propose.empty_repo",
          `found no source files in ${repo.label}, so there is nothing to plan against`,
        ),
      };
    }

    // The agent is pointed at a scratch directory, not the real repo. Proposing is a
    // read-and-think step and must not be able to leave a mark on the target, even by
    // accident — the survey it needs is handed to it as text.
    const scratch = await mkdtemp(join(tmpdir(), "signet-propose-"));
    try {
      const profileText = renderProfile(profile);
      await writeFile(join(scratch, "SURVEY.md"), profileText);

      const result = await this.deps.adapter.execute({
        workspacePath: scratch,
        prompt: buildPrompt(req.goal, profileText),
        maxTurns: this.deps.maxTurns ?? 6,
        ...(this.deps.model !== undefined ? { model: this.deps.model } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      if (!result.ok) {
        return { ok: false, error: result.error ?? nonRecoverable("propose.failed", "the proposer did not finish") };
      }

      const parsed = ValidatedFeatureProposalSchema.safeParse(extractJsonBlock(result.resultText));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          ok: false,
          error: {
            kind: "recoverable",
            code: "propose.unparseable",
            message: `proposal failed validation: ${issue?.path.join(".") ?? "?"} ${issue?.message ?? "bad shape"}`,
          },
        };
      }

      return {
        ok: true,
        response: {
          proposal: parsed.data,
          repoPath: repo.path,
          repoLabel: repo.label,
          repoOrigin: repo.origin,
          filesSurveyed: profile.files.length,
          surveyTruncated: profile.truncated.files,
          // Reported, not enforced. The user may know something the survey does not —
          // but they should know the survey disagrees before they sign.
          surfaceWarnings: checkSurfaces(parsed.data, profile),
        },
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

/** Turns an approved proposal into the create request, unchanged apart from shape. */
export function proposalToCreateRequest(proposal: FeatureProposal): {
  title: string;
  briefMd: string;
  increments: Array<{ title: string; declaredSurface: string[]; acceptanceMd: string }>;
} {
  return {
    title: proposal.title,
    // The brief keeps the understanding and the doubts. Signature 1 is a signature on
    // a researched plan now, which is worth more than a signature on prose the user
    // wrote thirty seconds earlier and has not forgotten.
    briefMd: [
      proposal.understanding,
      ...(proposal.uncertainties.length > 0
        ? ["", "## Open questions at approval time", ...proposal.uncertainties.map((u) => `- ${u}`)]
        : []),
    ].join("\n"),
    increments: proposal.steps.map((s) => ({
      title: s.title,
      declaredSurface: s.declaredSurface,
      acceptanceMd: s.acceptanceMd,
    })),
  };
}

/** Exported for the spec: a stable id for a proposal the UI is holding. */
export function proposalId(): string {
  return randomUUID();
}
