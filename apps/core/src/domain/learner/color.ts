// Color normalization + perceptual distance. Pure, dependency-free.
// Everything the learner compares goes through canonical form first:
// lowercase #rrggbb (alpha preserved separately when present).

export interface ParsedColor {
  hex: string; // canonical #rrggbb
  alpha: number; // 0..1
}

const HEX_RE = /#([0-9a-f]{3,8})\b/gi;
const RGB_RE = /rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)/gi;
const HSL_RE = /hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+%?)\s*)?\)/gi;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function toHex2(n: number): string {
  return clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
}

export function normalizeHex(raw: string): ParsedColor | null {
  const h = raw.replace("#", "").toLowerCase();
  if (![3, 4, 6, 8].includes(h.length)) return null;
  if (!/^[0-9a-f]+$/.test(h)) return null;
  if (h.length === 3 || h.length === 4) {
    const [r, g, b, a] = h.split("");
    return {
      hex: `#${r}${r}${g}${g}${b}${b}`,
      alpha: a !== undefined ? parseInt(a + a, 16) / 255 : 1,
    };
  }
  const hex = `#${h.slice(0, 6)}`;
  const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { hex, alpha };
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = ln - c / 2;
  return [Math.round((rgb[0] + m) * 255), Math.round((rgb[1] + m) * 255), Math.round((rgb[2] + m) * 255)];
}

function parseAlpha(a: string | undefined): number {
  if (a === undefined) return 1;
  return a.endsWith("%") ? clamp(parseFloat(a) / 100, 0, 1) : clamp(parseFloat(a), 0, 1);
}

/** Find every color literal in a text chunk, canonicalized, with its raw match. */
export function findColors(text: string): Array<{ raw: string; color: ParsedColor; index: number }> {
  const out: Array<{ raw: string; color: ParsedColor; index: number }> = [];
  for (const m of text.matchAll(HEX_RE)) {
    const c = normalizeHex(m[0]);
    if (c) out.push({ raw: m[0], color: c, index: m.index });
  }
  for (const m of text.matchAll(RGB_RE)) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (r > 255 || g > 255 || b > 255) continue;
    out.push({
      raw: m[0],
      color: { hex: `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`, alpha: parseAlpha(m[4]) },
      index: m.index,
    });
  }
  for (const m of text.matchAll(HSL_RE)) {
    const [r, g, b] = hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
    out.push({
      raw: m[0],
      color: { hex: `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`, alpha: parseAlpha(m[4]) },
      index: m.index,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

// ── perceptual distance (CIE76 in Lab — adequate for near-duplicate detection) ──

function srgbToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

export function hexToLab(hex: string): [number, number, number] {
  const r = srgbToLinear(parseInt(hex.slice(1, 3), 16));
  const g = srgbToLinear(parseInt(hex.slice(3, 5), 16));
  const b = srgbToLinear(parseInt(hex.slice(5, 7), 16));
  // sRGB D65 → XYZ
  let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  [x, y, z] = [f(x), f(y), f(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 deltaE between two canonical hex colors. < 2.3 ≈ imperceptible; < 10 ≈ near-duplicate. */
export function deltaE(hexA: string, hexB: string): number {
  const [l1, a1, b1] = hexToLab(hexA);
  const [l2, a2, b2] = hexToLab(hexB);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/** Is this a grey/near-neutral (low chroma)? Palette drift rules usually exempt neutrals. */
export function isNeutral(hex: string): boolean {
  const [, a, b] = hexToLab(hex);
  return Math.sqrt(a * a + b * b) < 12;
}
