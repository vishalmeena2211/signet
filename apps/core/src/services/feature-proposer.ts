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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AskQuestionsSchema,
  AskSurveySchema,
  type AskQuestions,
  type AskSurvey,
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
  /** What the person told us about this repo on first run, handed to the planner. */
  repoNote?: (repoPath: string) => Promise<string | null>;
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
        warnings.push({ stepTitle: step.title, pattern, reason: "outside_repo", suggestion: null });
        continue;
      }
      // A bare ** hands the agent the entire repository, which is the same as having
      // no surface at all — the guard is nominally present and enforcing nothing.
      if (pattern === "**" || pattern === "**/*" || pattern === "*") {
        warnings.push({ stepTitle: step.title, pattern, reason: "matches_everything", suggestion: null });
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

      warnings.push({ stepTitle: step.title, pattern, reason: "matches_nothing", suggestion: nearestPath(pattern, paths) });
    }
  }
  return warnings;
}

/**
 * The real file a mistaken surface most likely meant: one whose name shares the pattern's
 * most specific word (`src/clustering/**` → `src/cluster.ts`). Shortest wins; tests lose
 * to sources. Null when nothing is close, rather than a guess.
 */
export function nearestPath(pattern: string, paths: readonly string[]): string | null {
  const words = pattern
    .replace(/\*+/g, " ")
    .split(/[/\s._-]+/)
    .filter((w) => w.length >= 4 && !["src", "lib", "test", "tests", "spec", "index"].includes(w.toLowerCase()));
  const word = words.at(-1)?.toLowerCase();
  if (!word) return null;
  const stem = word.replace(/(ing|ers|er|s)$/, "");
  const hits = paths.filter((p) => {
    const base = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    return base.includes(stem);
  });
  if (hits.length === 0) return null;
  const isTest = (p: string) => /\.(spec|test)\./.test(p);
  return [...hits].sort((a, b) => Number(isTest(a)) - Number(isTest(b)) || a.length - b.length)[0] ?? null;
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
    '  "steps": [{ "title": string, "rationale": string, "declaredSurface": string[], "acceptanceMd": string,',
    '             "doubts": [{ "question": string, "options": string[], "suggested": number }] }],',
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
    "1. declaredSurface is a HARD boundary, not a hint. If the implementation needs a file",
    "   outside it, the step stops and waits for a person to decide. So list every file the",
    "   step will need, including the test file and any file it must read-and-edit. Prefer",
    "   naming concrete files over broad globs.",
    "2. Use paths that exist in the survey below, or new files that sit beside existing",
    "   ones. A surface matching nothing is worse than a surface that is too wide.",
    "3. Follow the repository's own test-naming convention exactly as reported. Inventing",
    "   a different one produces a file the repo cannot run.",
    "4. Each step must be independently mergeable — it leaves the repo working. If two",
    "   pieces of work cannot be merged separately, they are one step, not two.",
    "5. acceptanceMd states what done means specifically enough to check. Not 'works',",
    "   but the observable behaviour, including edge cases the request implies. Write it",
    "   as a short bulleted list, one promise per '- ' line, each one something a single",
    "   test can prove — every bullet is later paired with the test that proves it.",
    "6. Prefer FEWER steps. Two solid steps beat five speculative ones. One step is a",
    "   perfectly good answer for a small request.",
    "7. Pin anything you are guessing to the step it affects, as that step's doubts:",
    '   { "question": string, "options": string[], "suggested": number }. Give two to four',
    "   options and the index of the one you would pick. A guess recorded there is useful;",
    "   the same guess buried silently in a surface is how runs die. Use uncertainties only",
    "   for doubts that belong to no single step.",
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

  private async repoOf(repoId: string | undefined) {
    return this.deps.resolveRepo
      ? await this.deps.resolveRepo(repoId)
      : { path: this.deps.targetRepoPath, label: this.deps.targetRepoPath, origin: "local" as const };
  }

  /** What the survey found, before any model is asked anything. */
  async survey(repoId: string | undefined): Promise<AskSurvey> {
    const repo = await this.repoOf(repoId);
    return surveyFindings(repo.path, repo.label);
  }

  /** The questions worth asking before proposing. One model call. */
  async questions(goal: string, repoId: string | undefined) {
    const repo = await this.repoOf(repoId);
    return askQuestions({ adapter: this.deps.adapter, ...(this.deps.model !== undefined ? { model: this.deps.model } : {}) }, repo.path, goal);
  }

  /** Every file the survey sees, for pointing at one with @. */
  async files(repoId: string | undefined): Promise<string[]> {
    const repo = await this.repoOf(repoId);
    const profile = await profileRepo(repo.path);
    return profile.files.map((f) => f.path);
  }

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
      const note = (await this.deps.repoNote?.(repo.path)) ?? null;
      const profileText = renderProfile(profile) + (note ? `\n\n## What the person told us about this repo\n${note}\n` : "");
      await writeFile(join(scratch, "SURVEY.md"), profileText);

      const goal = req.answers?.length
        ? `${req.goal}\n\nAnswers the person gave before this proposal:\n${req.answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n")}`
        : req.goal;
      const result = await this.deps.adapter.execute({
        workspacePath: scratch,
        prompt: buildPrompt(goal, profileText),
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

const pexec = promisify(execFile);

export interface AskDeps {
  resolve: (repoId: string | undefined) => Promise<{ path: string; label: string; origin: "local" | "github" }>;
}

/**
 * What the survey found worth knowing, before anything is proposed: the entry points and
 * the largest modules, each with what it exports. Deterministic and free — this is the
 * part of "reading your repo" that needs no model.
 */
export async function surveyFindings(repoPath: string, label: string): Promise<AskSurvey> {
  const profile = await profileRepo(repoPath);
  const branch = await pexec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath })
    .then((r) => r.stdout.trim())
    .catch(() => "unknown");
  const isTest = (p: string) => /\.(spec|test)\./.test(p) || /(^|\/)(__tests__|tests?)\//.test(p);
  const code = profile.files.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb)$/.test(f.path) && !isTest(f.path));
  const picked = [
    ...profile.entryPoints.filter((e) => code.some((c) => c.path === e)),
    ...[...code].sort((a, b) => b.bytes - a.bytes).map((f) => f.path),
  ].filter((p, i, all) => all.indexOf(p) === i).slice(0, 4);
  const findings = await Promise.all(
    picked.map(async (path) => {
      const text = await readFile(`${repoPath}/${path}`, "utf8").then((t) => t.slice(0, 40_000)).catch(() => "");
      const names = [...text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|let|interface|type)\s+([A-Za-z_$][\w$]*)/g)]
        .map((m) => m[1])
        .filter((n, i, all) => n && all.indexOf(n) === i)
        .slice(0, 4);
      const lines = text.split("\n").length;
      return { path, note: names.length > 0 ? `exports ${names.join(", ")}` : `${lines} lines` };
    }),
  );
  return AskSurveySchema.parse({ repoLabel: label, repoPath, branch, filesSurveyed: profile.files.length, findings });
}

/** The questions whose answers would change the plan, asked before proposing it. */
export async function askQuestions(
  deps: { adapter: ProposerAdapter; model?: string },
  repoPath: string,
  goal: string,
): Promise<{ ok: true; questions: AskQuestions } | { ok: false; error: SignetError }> {
  const profile = await profileRepo(repoPath);
  const scratch = await mkdtemp(join(tmpdir(), "signet-ask-"));
  try {
    const profileText = renderProfile(profile);
    const prompt = [
      "Someone wants a change made to the codebase surveyed below. Before anything is planned,",
      "find what matters. Output ONLY a JSON object:",
      '{ "lead": string, "questions": [ { "question": string, "options": string[], "suggested": number, "note": string | null } ] }',
      "",
      "- lead: ONE sentence naming what in the repo you would build on, e.g. 'I can build on the",
      "  quad-tree in src/spatial.ts.' Then the questions follow it.",
      "- questions: at most three, and only ones whose answer would CHANGE the plan and that the",
      "  request does not settle. Each has two to four short options and the index of the one you",
      "  would pick. note is a short reason for your pick when the repo gives one, else null.",
      "- If nothing needs asking, return an empty questions list. Do not invent questions.",
      "",
      "## The request",
      goal,
      "",
      profileText,
    ].join("\n");
    const result = await deps.adapter.execute({
      workspacePath: scratch,
      prompt,
      maxTurns: 4,
      ...(deps.model !== undefined ? { model: deps.model } : {}),
    });
    if (!result.ok) return { ok: false, error: result.error ?? nonRecoverable("ask.failed", "the question pass did not finish") };
    const parsed = AskQuestionsSchema.safeParse(extractJsonBlock(result.resultText));
    if (!parsed.success) return { ok: false, error: { kind: "recoverable", code: "ask.unparseable", message: "the question pass did not return questions in the expected shape" } };
    return { ok: true, questions: parsed.data };
  } finally {
    await rm(scratch, { recursive: true, force: true });
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
