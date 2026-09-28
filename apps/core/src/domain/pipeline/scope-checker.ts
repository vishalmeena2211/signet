// Mechanical scope check: does the agent's plan stay inside the increment's
// declared surface? Surface entries are exact paths or globs (* within a
// segment, ** across segments). Pure and dependency-free — this check gates
// autonomy, so it must be trivially auditable.

export interface ScopeVerdict {
  inScope: boolean;
  outside: string[];
}

export function checkScope(planFiles: string[], declaredSurface: string[]): ScopeVerdict {
  const matchers = declaredSurface.map(compileSurfacePattern);
  const outside = planFiles.filter((f) => !matchers.some((m) => m.test(normalize(f))));
  return { inScope: outside.length === 0, outside };
}

function normalize(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

/**
 * Exported so a proposed surface can be checked against the SAME matcher that will
 * later judge it. A second, subtly different glob implementation elsewhere would let
 * a proposal pass review and then fail scope check — the worst of both.
 */
export function compileSurfacePattern(pattern: string): RegExp {
  const norm = normalize(pattern);
  let re = "";
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        // '**' spans segments; swallow a following '/' so 'a/**/b' matches 'a/b'
        re += norm[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += norm[i + 2] === "/" ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch !== undefined && /[.+?^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch ?? "";
    }
  }
  return new RegExp(`^${re}$`);
}

/** Whether one path is inside a surface — the same matcher, for display. */
export function matchesSurface(path: string, declaredSurface: readonly string[]): boolean {
  const p = normalize(path);
  return declaredSurface.some((s) => compileSurfacePattern(s).test(p));
}
