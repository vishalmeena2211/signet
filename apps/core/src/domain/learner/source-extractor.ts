// Source extractor v1 — mines a repository's DESIGN FACTS without running it:
//   declared tokens  : CSS custom property definitions + Tailwind theme refs
//   used values      : color literals (hex/rgb/hsl) with file:line evidence
//   assets           : image files + how often each is referenced from source
// Read-only by contract: this module never writes inside the target repo.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, extname, basename } from "node:path";
import { findColors, type ParsedColor } from "./color.js";

export interface ColorUsage {
  hex: string;
  alpha: number;
  raw: string;
  file: string; // repo-relative
  line: number;
  context: "css" | "markup" | "code" | "svg" | "config";
}

export interface DeclaredToken {
  name: string; // e.g. --grey-500 or theme key
  value: string;
  resolvedHex: string | null; // when the value is a color literal
  file: string;
  line: number;
}

export interface AssetInfo {
  file: string; // repo-relative path of the asset
  kind: "svg" | "png" | "jpg" | "webp" | "ico" | "gif";
  bytes: number;
  references: number; // how many source files mention its basename
  referencedFrom: string[]; // up to 10 sample files
  paletteHexes: string[]; // for svg: color literals inside the asset itself
}

export interface SourceExtraction {
  root: string;
  scannedFiles: number;
  colors: ColorUsage[];
  declaredTokens: DeclaredToken[];
  assets: AssetInfo[];
}

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".scss", ".svg", ".html", ".vue"]);
const ASSET_EXTS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".gif"]);
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  ".turbo",
  ".worktrees",
  "coverage",
  ".devdb",
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function contextFor(ext: string): ColorUsage["context"] {
  if (ext === ".css" || ext === ".scss") return "css";
  if (ext === ".svg") return "svg";
  if (ext === ".html" || ext === ".vue") return "markup";
  return "code";
}

const CUSTOM_PROP_RE = /(--[a-zA-Z][\w-]*)\s*:\s*([^;]+);/g;

export async function extractFromSource(root: string): Promise<SourceExtraction> {
  const files: string[] = [];
  const assets: Array<{ path: string; bytes: number }> = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(join(dir, e.name));
        continue;
      }
      const ext = extname(e.name).toLowerCase();
      const full = join(dir, e.name);
      if (ASSET_EXTS.has(ext)) {
        const s = await stat(full).catch(() => null);
        if (s) assets.push({ path: full, bytes: s.size });
      }
      if (SOURCE_EXTS.has(ext)) files.push(full);
    }
  }
  await walk(root);

  const colors: ColorUsage[] = [];
  const declaredTokens: DeclaredToken[] = [];
  const sourceTexts = new Map<string, string>();

  for (const file of files) {
    const s = await stat(file).catch(() => null);
    if (!s || s.size > MAX_FILE_BYTES) continue;
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    const rel = relative(root, file);
    sourceTexts.set(rel, text);
    const ext = extname(file).toLowerCase();
    const ctx = contextFor(ext);

    // color literals with line numbers
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
    const lineOf = (idx: number): number => {
      let lo = 0,
        hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((lineStarts[mid] ?? 0) <= idx) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    for (const hit of findColors(text)) {
      colors.push({
        hex: hit.color.hex,
        alpha: hit.color.alpha,
        raw: hit.raw,
        file: rel,
        line: lineOf(hit.index),
        context: ctx,
      });
    }

    // declared tokens: CSS custom properties anywhere (css files and styled strings)
    if (ctx === "css" || ctx === "code") {
      for (const m of text.matchAll(CUSTOM_PROP_RE)) {
        const value = (m[2] ?? "").trim();
        const colorHits = findColors(value);
        const first = colorHits[0];
        declaredTokens.push({
          name: m[1] ?? "",
          value,
          resolvedHex: colorHits.length === 1 && first ? first.color.hex : null,
          file: rel,
          line: lineOf(m.index),
        });
      }
    }
  }

  // asset reference counting: does any source text mention the asset's basename?
  const assetInfos: AssetInfo[] = [];
  for (const a of assets) {
    const rel = relative(root, a.path);
    const name = basename(a.path);
    const referencedFrom: string[] = [];
    for (const [srcRel, text] of sourceTexts) {
      if (srcRel === rel) continue;
      if (text.includes(name)) {
        referencedFrom.push(srcRel);
        if (referencedFrom.length >= 10) break;
      }
    }
    let paletteHexes: string[] = [];
    if (extname(a.path).toLowerCase() === ".svg" && a.bytes <= MAX_FILE_BYTES) {
      const svg = await readFile(a.path, "utf8").catch(() => "");
      paletteHexes = [...new Set(findColors(svg).map((h) => h.color.hex))];
    }
    const extRaw = extname(a.path).slice(1).toLowerCase();
    const kind = (extRaw === "jpeg" ? "jpg" : extRaw) as AssetInfo["kind"];
    assetInfos.push({ file: rel, kind, bytes: a.bytes, references: referencedFrom.length, referencedFrom, paletteHexes });
  }

  return { root, scannedFiles: files.length, colors, declaredTokens, assets: assetInfos };
}

export type { ParsedColor };
