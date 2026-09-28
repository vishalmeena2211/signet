// Promises and their proof.
//
// "Done when" is a list of promises. Checks passing is not the same as every promise
// being kept: a suite can be green while one promise has no test at all. So each promise
// is paired with the test that proves it — CLAIMED by the agent, which knows what it
// wrote, and then CHECKED here against the change itself. A claim naming a test that is
// not in the diff is not proof, however confident it sounds.
//
// What this can and cannot establish, stated plainly: it proves the named test was
// ADDED in this change and that the suite passed (the tests gate ran it). It does not
// prove the test asserts the promise faithfully — that is what the person at the seal
// is for, and why the test's name and file are shown next to each promise.

import { ProofClaimsSchema, type ProofClaim, type PromiseProof } from "@signet/contracts";

const MAX_PROMISES = 12;

/** Markdown emphasis and code marks, removed so a promise reads as a sentence. */
function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The promises in a step's "done when", in order.
 *
 * Bullets first, because that is how the proposer is asked to write them and a bullet
 * is an unambiguous boundary. Failing that, bold spans (the wireframes' convention for
 * "this part a test must prove"). Failing that, sentences — the weakest split, but a
 * paragraph with three sentences is usually three promises.
 */
export function extractPromises(acceptanceMd: string): string[] {
  const text = acceptanceMd.trim();
  if (text === "") return [];

  const bullets = text
    .split("\n")
    .map((l) => /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l)?.[1])
    .filter((l): l is string => l !== undefined && l.trim() !== "")
    .map(plain);
  if (bullets.length > 0) return dedupe(bullets);

  const bold = [...text.matchAll(/\*\*(.+?)\*\*/g)].map((m) => plain(m[1] ?? ""));
  if (bold.length > 0) return dedupe(bold);

  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9`"“])/)
    .map(plain)
    .filter((s) => s.length > 3);
  return dedupe(sentences);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const key = i.toLowerCase();
    if (!seen.has(key) && i !== "") {
      seen.add(key);
      out.push(i);
    }
  }
  return out.slice(0, MAX_PROMISES);
}

/** The instruction appended to the implement prompt, numbering the promises. */
export function proofInstruction(promises: readonly string[]): string {
  if (promises.length === 0) return "";
  return [
    "## Promises — each must be proven by a test you add",
    ...promises.map((p, i) => `${i + 1}. ${p}`),
    "",
    "When you are done, end your reply with ONE fenced json block naming the test that",
    "proves each promise, exactly as the test's title is written in the code:",
    "```json",
    '{ "proofs": [ { "promise": 1, "test": "exact test title", "testFile": "path/to/file.test.ts",',
    '                "codeFile": "path/to/source.ts", "codeLines": "41-44" } ] }',
    "```",
    'If no test proves a promise, give "test": null for it rather than naming one that does not.',
    "Signet checks every claim against the change, so an unproven promise is reported either way.",
  ].join("\n");
}

/**
 * The proof claims in an agent's closing message. Scans every fenced block and uses the
 * LAST one that parses, because the agent often shows other JSON on the way.
 */
export function parseProofClaims(resultText: string): ProofClaim[] | null {
  const blocks = [...resultText.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  // A bare object at the end counts too — not every reply fences it.
  const tail = resultText.slice(resultText.lastIndexOf('{"proofs"'));
  if (resultText.includes('{"proofs"')) blocks.push(tail);
  for (const block of blocks.reverse()) {
    if (!block.includes("proofs")) continue;
    const start = block.indexOf("{");
    const end = block.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    let json: unknown;
    try {
      json = JSON.parse(block.slice(start, end + 1)); // signet-policy-allow: raw-json-parse -- validated by ProofClaimsSchema on the next line
    } catch {
      continue;
    }
    const parsed = ProofClaimsSchema.safeParse(json);
    if (parsed.success) return parsed.data.proofs;
  }
  return null;
}

// ── the change, as the checker needs it ────────────────────────────────────────

export interface FileChange {
  /** New-side line number → the added line's text. */
  added: Map<number, string>;
  /** New-side ranges touched, inclusive. */
  hunks: Array<[number, number]>;
}

/** A unified diff (any context size) → per-file added lines and hunk ranges. */
export function parseUnifiedDiff(patch: string): Map<string, FileChange> {
  const files = new Map<string, FileChange>();
  let current: FileChange | null = null;
  let line = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).replace(/^b\//, "").trim();
      if (path === "/dev/null") {
        current = null;
        continue;
      }
      current = { added: new Map(), hunks: [] };
      files.set(path, current);
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git") || raw.startsWith("index ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      current?.hunks.push([line, line + Math.max(count, 1) - 1]);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+")) {
      current.added.set(line, raw.slice(1));
      line += 1;
    } else if (raw.startsWith("-")) {
      // removed: the new-side counter does not move
    } else if (raw.startsWith(" ")) {
      line += 1;
    }
  }
  return files;
}

const isTestFile = (f: string): boolean => /\.(spec|test)\.(c|m)?[jt]sx?$/.test(f) || /(^|\/)(__tests__|tests?)\//.test(f);

/** Quotes and whitespace differ between how an agent writes a title and how code does. */
function norm(s: string): string {
  return s.replace(/[“”"'`’‘]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function parseRange(lines: string): [number, number] | null {
  const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(lines);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return a <= b ? [a, b] : [b, a];
}

/**
 * Checks each promise's claim against the change. Pure: the diff is passed in, so this
 * is testable without git.
 */
export function verifyProofs(input: {
  promises: readonly string[];
  claims: readonly ProofClaim[] | null;
  changes: Map<string, FileChange>;
}): PromiseProof[] {
  const testFiles = [...input.changes.keys()].filter(isTestFile);

  return input.promises.map((promise, i) => {
    const unproven = (reason: string): PromiseProof => ({
      promise,
      proven: false,
      test: claim?.test ?? null,
      testFile: claim?.testFile ?? null,
      codeFile: null,
      codeLines: null,
      reason,
    });
    const claim = input.claims?.find((c) => c.promise === i + 1);

    if (input.claims === null) return unproven("The agent did not say which test proves this.");
    if (!claim || !claim.test) return unproven("No test proves this.");

    const wanted = norm(claim.test);
    const candidates = claim.testFile && input.changes.has(claim.testFile) ? [claim.testFile] : testFiles;
    const where = candidates.find((f) =>
      [...(input.changes.get(f)?.added.values() ?? [])].some((l) => norm(l).includes(wanted)),
    );
    if (!where) {
      return unproven(`It named the test “${claim.test}”, but no test with that title was added in this change.`);
    }

    // The lines are a pointer for the reviewer, not the proof. Kept only when they land
    // inside what actually changed; otherwise dropped rather than shown wrong.
    let codeFile: string | null = null;
    let codeLines: string | null = null;
    if (claim.codeFile && claim.codeLines) {
      const change = input.changes.get(claim.codeFile);
      const range = parseRange(claim.codeLines);
      if (change && range && change.hunks.some(([a, b]) => range[0] <= b && range[1] >= a)) {
        codeFile = claim.codeFile;
        codeLines = range[0] === range[1] ? String(range[0]) : `${range[0]}–${range[1]}`;
      }
    }

    return { promise, proven: true, test: claim.test, testFile: where, codeFile, codeLines, reason: null };
  });
}
