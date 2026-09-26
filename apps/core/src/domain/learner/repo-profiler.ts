// What this repository looks like, so a breakdown can be proposed instead of guessed.
//
// The problem this exists to solve, stated plainly: feature creation used to ask the
// user to declare the steps AND the file globs each step was allowed to touch. Only
// somebody who already knows the codebase can answer that, and getting it wrong is
// not a soft failure — a plan that touches a file outside its declared surface is a
// NON-recoverable error, so the run is killed with no repair. Two of the four items
// in the pilot's attention queue were exactly this:
//
//   · "Add withDiscount()" — the agent returned an empty file list.
//   · "do whatever"        — the agent needed cart.mjs; the hand-written surface
//                            said otherwise, and the run died.
//
// In both cases the agent knew which files the work needed and the human's guess did
// not match. So the guess has to move to the side that has the repository open.
//
// This module is the input to that: a deterministic survey the proposer reads before
// suggesting anything. Deterministic on purpose — it walks files and counts, with no
// model call, so profiling is free and identical every time. The existing learner
// cannot serve this: it understands colours, tokens and image assets, and knows
// nothing about where a codebase's seams are.
//
// Read-only by contract. Like the rest of the learner, this module never writes
// inside the target repository.

import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

export interface ProfiledFile {
  /** Repo-relative, forward-slashed. */
  path: string;
  bytes: number;
  /** Lines, for a sense of weight that bytes alone does not give. */
  lines: number;
  /** Looks like a test, by the repo's own naming convention. */
  isTest: boolean;
  /**
   * The file's text, when it is small enough to be worth carrying. Null for anything
   * large — a minified bundle would crowd out everything useful.
   *
   * This exists because the first real proposal said so itself: "I couldn't read the
   * file contents; only names and line counts were available", and went on to assume
   * cart.mjs computed a total. Planning from a directory listing is guessing with
   * extra steps, and the profiler was already reading every file to count its lines,
   * so the text was in memory and being discarded.
   */
  content: string | null;
}

export interface DirectorySummary {
  /** Repo-relative directory, "." for the root. */
  path: string;
  files: number;
  bytes: number;
  /** Extensions present, most common first. */
  extensions: string[];
}

export interface RepoProfile {
  root: string;
  /** Every source file we consider part of the codebase. */
  files: ProfiledFile[];
  /** Roll-up per directory, so a large tree can be described without listing it all. */
  directories: DirectorySummary[];
  /** Extension -> file count, most common first. */
  languages: Array<{ ext: string; files: number }>;
  /**
   * How this repo names its tests, inferred rather than assumed. A proposal that
   * invents `__tests__/foo.js` for a repo that uses `foo.test.mjs` produces a
   * surface that matches no file, which is how you get an empty plan.
   */
  testConvention: { pattern: string; examples: string[] } | null;
  /** Files that look like entry points, by conventional name. */
  entryPoints: string[];
  /** Manifest files worth reading in full — the proposer gets their contents. */
  manifests: Array<{ path: string; content: string }>;
  /** Truncation is reported, never silent: a partial survey must not read as complete. */
  truncated: { files: boolean; limit: number };
}

const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".css", ".scss", ".html", ".vue", ".svelte",
  ".py", ".go", ".rs", ".rb", ".java", ".kt", ".swift", ".php", ".cs",
  ".sql", ".graphql", ".prisma",
  ".md", ".json", ".yml", ".yaml", ".toml",
]);

/** Directories that are build output or dependencies, not the codebase. */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", ".turbo",
  ".worktrees", "coverage", ".devdb", "generated", "__pycache__",
  ".venv", "venv", "target", "vendor", ".cache", ".pnpm-store",
]);

/** Read in full and handed to the proposer — these describe how the repo is run. */
const MANIFEST_NAMES = new Set([
  "package.json", "tsconfig.json", "pyproject.toml", "go.mod", "Cargo.toml",
  "Gemfile", "pom.xml", "build.gradle", "composer.json", "requirements.txt",
]);

const ENTRY_NAMES = new Set([
  "index.ts", "index.js", "index.mjs", "index.tsx", "main.ts", "main.js",
  "main.mjs", "main.py", "main.go", "main.rs", "app.ts", "app.js", "server.ts",
  "server.js", "cli.ts", "cli.js", "mod.rs", "lib.rs", "__main__.py",
]);

/** A single manifest that is enormous is a minified artefact, not documentation. */
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Per-file ceiling for retained text. Above this a file is listed but not quoted. */
const MAX_CONTENT_BYTES = 24 * 1024;
/**
 * A ceiling on how many files we profile. A monorepo can hold a hundred thousand
 * files and the proposer cannot read them all anyway; what matters is that hitting
 * the ceiling is REPORTED, so a partial survey is never mistaken for a full one.
 */
const MAX_FILES = 4000;

/** The test-naming conventions worth recognising, most specific first. */
const TEST_PATTERNS: Array<{ pattern: string; test: (p: string) => boolean }> = [
  { pattern: "*.spec.*", test: (p) => /\.spec\.[^/]+$/.test(p) },
  { pattern: "*.test.*", test: (p) => /\.test\.[^/]+$/.test(p) },
  { pattern: "test_*.py", test: (p) => /(^|\/)test_[^/]+\.py$/.test(p) },
  { pattern: "*_test.go", test: (p) => p.endsWith("_test.go") },
  { pattern: "tests/**", test: (p) => /(^|\/)tests?\//.test(p) },
  { pattern: "__tests__/**", test: (p) => /(^|\/)__tests__\//.test(p) },
];

function looksLikeTest(relPath: string): boolean {
  return TEST_PATTERNS.some((c) => c.test(relPath));
}

/** Walks the tree once, collecting everything the profile needs. */
async function walk(
  root: string,
  dir: string,
  out: ProfiledFile[],
  manifests: Array<{ path: string; content: string }>,
): Promise<void> {
  if (out.length >= MAX_FILES) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory is skipped rather than fatal: a survey that refuses
    // to describe a repo because one folder had odd permissions is less useful
    // than one that describes the rest.
    return;
  }

  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(root, full, out, manifests);
      continue;
    }
    if (!entry.isFile()) continue;

    const relPath = relative(root, full).split("\\").join("/");
    const ext = extname(entry.name).toLowerCase();

    if (MANIFEST_NAMES.has(entry.name)) {
      try {
        const st = await stat(full);
        if (st.size <= MAX_MANIFEST_BYTES) {
          manifests.push({ path: relPath, content: await readFile(full, "utf8") });
        }
      } catch {
        /* unreadable manifest: the rest of the profile still stands */
      }
    }

    if (!SOURCE_EXTS.has(ext)) continue;

    try {
      const st = await stat(full);
      if (st.size > MAX_FILE_BYTES) continue;
      // Counting lines means reading the file. Worth it: "this file is 40 lines"
      // and "this file is 4000 lines" imply very different decompositions, and
      // byte size conflates the two with minification and long lines.
      const text = await readFile(full, "utf8");
      out.push({
        path: relPath,
        bytes: st.size,
        lines: text.length === 0 ? 0 : text.split("\n").length,
        isTest: looksLikeTest(relPath),
        content: st.size <= MAX_CONTENT_BYTES ? text : null,
      });
    } catch {
      /* binary or unreadable: not part of the survey */
    }
  }
}

function summariseDirectories(files: ProfiledFile[]): DirectorySummary[] {
  const byDir = new Map<string, { files: number; bytes: number; exts: Map<string, number> }>();
  for (const f of files) {
    const slash = f.path.lastIndexOf("/");
    const dir = slash === -1 ? "." : f.path.slice(0, slash);
    const agg = byDir.get(dir) ?? { files: 0, bytes: 0, exts: new Map() };
    agg.files += 1;
    agg.bytes += f.bytes;
    const ext = extname(f.path).toLowerCase();
    agg.exts.set(ext, (agg.exts.get(ext) ?? 0) + 1);
    byDir.set(dir, agg);
  }
  return [...byDir.entries()]
    .map(([path, agg]) => ({
      path,
      files: agg.files,
      bytes: agg.bytes,
      extensions: [...agg.exts.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e),
    }))
    .sort((a, b) => b.files - a.files);
}

function inferTestConvention(files: ProfiledFile[]): RepoProfile["testConvention"] {
  // The convention with the most matching files wins. Ties go to the more specific
  // pattern, which is why TEST_PATTERNS is ordered.
  let best: { pattern: string; examples: string[] } | null = null;
  let bestCount = 0;
  for (const candidate of TEST_PATTERNS) {
    const matches = files.filter((f) => candidate.test(f.path));
    if (matches.length > bestCount) {
      bestCount = matches.length;
      best = { pattern: candidate.pattern, examples: matches.slice(0, 5).map((f) => f.path) };
    }
  }
  // No tests found is a real answer, and a more useful one than a guess: it tells
  // the proposer not to promise a test file in a repo that has none.
  return best;
}

/**
 * Surveys a repository. Never throws for repo-shaped reasons — an empty or
 * unreadable tree yields an empty profile, because "I could not learn anything
 * about this repo" is information the proposer should act on rather than an
 * exception that hides the reason.
 */
export async function profileRepo(root: string): Promise<RepoProfile> {
  const files: ProfiledFile[] = [];
  const manifests: Array<{ path: string; content: string }> = [];
  await walk(root, root, files, manifests);

  files.sort((a, b) => a.path.localeCompare(b.path));

  const langs = new Map<string, number>();
  for (const f of files) {
    const ext = extname(f.path).toLowerCase();
    langs.set(ext, (langs.get(ext) ?? 0) + 1);
  }

  return {
    root,
    files,
    directories: summariseDirectories(files),
    languages: [...langs.entries()]
      .map(([ext, count]) => ({ ext, files: count }))
      .sort((a, b) => b.files - a.files),
    testConvention: inferTestConvention(files),
    entryPoints: files
      .filter((f) => ENTRY_NAMES.has(f.path.slice(f.path.lastIndexOf("/") + 1)))
      .map((f) => f.path),
    manifests,
    truncated: { files: files.length >= MAX_FILES, limit: MAX_FILES },
  };
}

/**
 * The profile as the text a model reads. Kept beside the profiler so the shape and
 * its rendering cannot drift, and deliberately compact: a file list long enough to
 * dominate the prompt crowds out the thing we actually want the model thinking about.
 */
export function renderProfile(
  profile: RepoProfile,
  opts: { maxFiles?: number; contentBudget?: number } = {},
): string {
  const maxFiles = opts.maxFiles ?? 400;
  // Roughly 12k tokens of code. Generous enough to hold a small repo whole, small
  // enough that the instructions do not get lost behind it.
  const contentBudget = opts.contentBudget ?? 48_000;
  const lines: string[] = [];

  lines.push(`# Repository survey`);
  lines.push(`${profile.files.length} source files across ${profile.directories.length} directories.`);
  if (profile.truncated.files) {
    // Said out loud, because a proposal built on a partial view should be treated
    // with less confidence than one built on the whole repo.
    lines.push(`NOTE: survey stopped at ${profile.truncated.limit} files, so this is partial.`);
  }

  if (profile.languages.length > 0) {
    lines.push("", "## Languages", profile.languages.map((l) => `${l.ext || "(none)"} ×${l.files}`).join(", "));
  }

  if (profile.testConvention) {
    lines.push(
      "",
      "## How this repo names tests",
      `${profile.testConvention.pattern} — for example ${profile.testConvention.examples.join(", ")}`,
      `Any test file you propose MUST follow this convention, or its surface will match nothing.`,
    );
  } else {
    lines.push("", "## How this repo names tests", "No test files found. Do not assume a test framework exists.");
  }

  if (profile.entryPoints.length > 0) {
    lines.push("", "## Entry points", profile.entryPoints.slice(0, 20).join("\n"));
  }

  lines.push(
    "",
    "## Directories",
    ...profile.directories.slice(0, 40).map((d) => `${d.path}/ — ${d.files} files (${d.extensions.slice(0, 4).join(" ")})`),
  );

  lines.push("", "## Files");
  for (const f of profile.files.slice(0, maxFiles)) {
    lines.push(`${f.path} — ${f.lines} lines${f.isTest ? " (test)" : ""}`);
  }
  if (profile.files.length > maxFiles) {
    lines.push(`… and ${profile.files.length - maxFiles} more files not listed.`);
  }

  for (const m of profile.manifests.slice(0, 4)) {
    lines.push("", `## ${m.path}`, m.content.trim());
  }

  // The actual code, within a budget. Without this the proposer is planning from a
  // directory listing, which is how the first real proposal ended up assuming what
  // cart.mjs did rather than knowing.
  //
  // Ordering is deliberate: entry points first because they show how the pieces fit
  // together, then remaining source smallest-first to buy BREADTH over depth (seeing
  // eight small modules beats seeing one big one), and tests last — they are the best
  // evidence of the repo's conventions, but only once the code itself is in.
  const quotable = profile.files.filter((f) => f.content !== null && f.content.trim().length > 0);
  const entry = new Set(profile.entryPoints);
  const ordered = [
    ...quotable.filter((f) => entry.has(f.path)),
    ...quotable.filter((f) => !entry.has(f.path) && !f.isTest).sort((a, b) => a.bytes - b.bytes),
    ...quotable.filter((f) => !entry.has(f.path) && f.isTest).sort((a, b) => a.bytes - b.bytes),
  ];

  let spent = 0;
  const shown: string[] = [];
  let omitted = 0;
  for (const f of ordered) {
    const text = (f.content as string).trimEnd();
    if (spent + text.length > contentBudget) {
      omitted += 1;
      continue;
    }
    spent += text.length;
    shown.push(`### ${f.path}\n\`\`\`\n${text}\n\`\`\``);
  }

  if (shown.length > 0) {
    lines.push("", "## File contents", ...shown);
    if (omitted > 0) {
      // Named explicitly, so a plan built on a partial read is not mistaken for one
      // built on the whole codebase.
      lines.push(
        "",
        `NOTE: ${omitted} more file${omitted === 1 ? "" : "s"} were not quoted above because the budget ran out. Do not assume you have seen everything.`,
      );
    }
  }

  return lines.join("\n");
}
