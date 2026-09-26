// The words on screen are checked, not just chosen once.
//
// "Increment" is the domain model's word and a fine one internally — it appears
// in the API, the database and half the variable names in this package. It is
// also meaningless to anyone who has not read the design document, and it was all
// over the interface.
//
// Vocabulary drifts back the moment nobody is looking, because the internal word
// is the one already in your head while you are writing the code. So this scans
// the source for jargon inside user-visible strings and fails if it returns.
//
// It deliberately checks the SOURCE rather than a rendered tree: a rendering test
// only sees the strings a particular fixture happens to reach, and the whole
// problem is the string on the screen nobody opened.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// process.cwd(), not import.meta.url: Vite rewrites module URLs with an /@fs
// prefix that is not a real filesystem path. Vitest runs with the package root as
// the working directory.
const SRC = join(process.cwd(), "src");

/** Words that must never reach a user, and what to say instead. */
const BANNED: { word: RegExp; say: string }[] = [
  { word: /\bincrements?\b/i, say: "step / steps" },
  { word: /\bsignature [12]\b/i, say: "name the action: 'Approve and start' or 'Merge'" },
  { word: /\bdesign of record\b/i, say: "approved design" },
  { word: /\bescalations?\b/i, say: "question" },
  { word: /\bcontext pack\b/i, say: "briefing" },
  { word: /\bdeclared surface\b/i, say: "files it may change" },
  { word: /\bworktrees?\b/i, say: "working copy" },
  { word: /\bidempotenc|idempotent\b/i, say: "say what it guarantees, not the mechanism" },
  { word: /\bdispatcher\b/i, say: "pipeline" },
  { word: /\boutbox\b/i, say: "queue, or do not surface it" },
  { word: /\bdemoted\b/i, say: "set aside" },
  { word: /\bconformance\b/i, say: "design check" },
  { word: /\bquota window\b/i, say: "Claude quota" },
];

/**
 * Pulls the strings a user could actually read: JSX text, and the values of the
 * props that render as text. Code identifiers, imports, query keys and route
 * values are ignored on purpose — those SHOULD keep the domain vocabulary.
 */
function visibleStrings(source: string, isJsx: boolean): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const out: string[] = [];

  // String-valued props that end up on screen.
  const textProps =
    /\b(?:label|title|header|placeholder|hint|body|help|blurb|cta|confirmLabel|question|summary|detail|emptyNote)\s*=\s*["'{`]/g;
  let m: RegExpExecArray | null;
  while ((m = textProps.exec(withoutComments))) {
    const rest = withoutComments.slice(m.index, m.index + 400);
    const q = /["'`]([^"'`]{2,300})["'`]/.exec(rest);
    if (q?.[1]) out.push(q[1]);
  }

  // Object literals of the shape { label: "…", help: "…" } — the status maps.
  const objText = /\b(?:label|help|blurb|cta|say|detail)\s*:\s*["'`]([^"'`]{2,300})["'`]/g;
  while ((m = objText.exec(withoutComments))) if (m[1]) out.push(m[1]);

  // Bare JSX text between tags, which is where prose lives. Only in .tsx: in a
  // plain .ts file the same pattern matches a TypeScript generic such as
  // Promise<DispatcherState>, which no user ever sees.
  if (isJsx) {
    const jsxText = />([^<>{}]{6,400})</g;
    while ((m = jsxText.exec(withoutComments))) {
      const t = m[1]?.trim();
      if (t && /[a-z]{3}/i.test(t)) out.push(t);
    }
  }

  // toast.push("…") and similar single-string calls that are read aloud.
  const calls = /\b(?:push|toast)\s*\(\s*["'`]([^"'`]{4,300})["'`]/g;
  while ((m = calls.exec(withoutComments))) if (m[1]) out.push(m[1]);

  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...sourceFiles(p));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.spec\.tsx?$/.test(entry)) continue;
    if (entry === "words.ts") continue; // the glossary names the banned words on purpose
    out.push(p);
  }
  return out;
}

describe("the console speaks plainly", () => {
  const files = sourceFiles(SRC);

  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(BANNED)("never says $say's jargon on screen", ({ word, say }) => {
    const offences: string[] = [];
    for (const file of files) {
      for (const text of visibleStrings(readFileSync(file, "utf8"), file.endsWith(".tsx"))) {
        if (word.test(text)) {
          offences.push(`${file.replace(SRC, "src")}: "${text.slice(0, 90)}"  → say: ${say}`);
        }
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("keeps the domain vocabulary in the CODE, where it belongs", () => {
    // The point is not to purge the word — the API says "increment" and so should
    // the variables that carry it. This asserts the internal name survives, so a
    // later cleanup does not rename the model to match the interface.
    const feature = readFileSync(join(SRC, "screens", "Feature.tsx"), "utf8");
    expect(feature).toContain("incrementId");
    expect(feature).toContain("IncrementDetail");
  });
});
