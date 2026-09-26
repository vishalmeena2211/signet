// Force-directed layout, in about a hundred lines and zero dependencies.
//
// Every graph library evaluated would have added more to the bundle than the
// whole console currently costs, and all of them want colours as JS values —
// which fights a design system built on CSS custom properties. SVG plus a small
// simulation keeps theming declarative (`fill: var(--accent)` just works in both
// themes) and adds nothing to install.
//
// The layout is computed synchronously and deterministically rather than animated:
// the same graph always lands in the same arrangement, so a screenshot is
// reproducible, a test can assert positions, and there is no animation jank on a
// screen someone is trying to read.

export interface LayoutNode {
  id: string;
  kind: string;
  /** Degree drives node size: the well-connected are the load-bearing ones. */
  degree: number;
  x: number;
  y: number;
}

export interface LayoutInput {
  nodes: readonly { id: string; kind: string }[];
  edges: readonly { from: string; to: string }[];
  width: number;
  height: number;
}

/**
 * Above this, an O(n²) repulsion pass stops being free, so we fall back to a
 * deterministic radial arrangement by kind. Degrading honestly beats freezing the
 * tab, and the filters exist precisely so you can get back under this number.
 */
const FORCE_LIMIT = 600;

/** Deterministic pseudo-random from a string — no Math.random, so layout is stable. */
function hash01(s: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // >>> 0 to unsigned, then normalise
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Rank order for the layered view, left to right. This is the product's causal
 * chain read as a sentence: a file is evidence for a rule, which governs a
 * convention, which a design of record permits or bans, for an increment of work.
 *
 * Layering beats force-directed here because the data really is a DAG whose edges
 * mostly point one way — a force pass scrambles that structure into a blob, while
 * ranks show it as a flow you can read.
 */
const RANK: Record<string, number> = {
  repo: 0,
  file: 1,
  rule: 2,
  convention: 3,
  design: 4,
  increment: 5,
};

/**
 * Layered layout: assign each node a column by kind, then order within columns to
 * pull connected nodes level with each other (a barycentre sweep, the standard
 * cheap crossing-reduction heuristic).
 */
export function layered(input: LayoutInput): { nodes: LayoutNode[]; mode: "layered" } {
  const { width, height } = input;

  const degree = new Map<string, number>();
  for (const e of input.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  const nodes: LayoutNode[] = input.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    degree: degree.get(n.id) ?? 0,
    x: 0,
    y: 0,
  }));
  if (nodes.length === 0) return { nodes, mode: "layered" };

  // Only lay out the ranks actually present, so a filtered graph still fills the box.
  const present = [...new Set(nodes.map((n) => RANK[n.kind] ?? 9))].sort((a, b) => a - b);
  const column = new Map<number, number>(present.map((r, i) => [r, i]));

  const byColumn = new Map<number, LayoutNode[]>();
  for (const n of nodes) {
    const col = column.get(RANK[n.kind] ?? 9) ?? 0;
    byColumn.set(col, [...(byColumn.get(col) ?? []), n]);
  }

  // Start each column ordered by connectivity, so hubs sit centrally rather than
  // at an arbitrary edge.
  for (const list of byColumn.values()) list.sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));

  const neighbours = new Map<string, string[]>();
  for (const e of input.edges) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
  }

  const place = () => {
    for (const [col, list] of byColumn) {
      const x = margin(width) + (col * (width - margin(width) * 2)) / Math.max(present.length - 1, 1);
      list.forEach((n, i) => {
        n.x = x;
        n.y = ((i + 1) / (list.length + 1)) * height;
      });
    }
  };
  place();

  // Barycentre sweeps: reposition each node to the mean height of its neighbours,
  // then re-sort the column by that. Four passes is plenty at this scale.
  const position = new Map<string, number>();
  for (let pass = 0; pass < 4; pass++) {
    for (const n of nodes) position.set(n.id, n.y);
    for (const list of byColumn.values()) {
      const bary = new Map<string, number>();
      for (const n of list) {
        const ns = neighbours.get(n.id) ?? [];
        const ys = ns.map((id) => position.get(id)).filter((y): y is number => y !== undefined);
        // A node with no neighbours keeps its place rather than collapsing to zero.
        bary.set(n.id, ys.length === 0 ? n.y : ys.reduce((a, b) => a + b, 0) / ys.length);
      }
      list.sort((a, b) => (bary.get(a.id) ?? 0) - (bary.get(b.id) ?? 0) || a.id.localeCompare(b.id));
    }
    place();
  }

  return { nodes, mode: "layered" };
}

function margin(width: number): number {
  return Math.min(70, width * 0.08);
}

export function layout(input: LayoutInput): { nodes: LayoutNode[]; mode: "force" | "radial" } {
  const { width, height } = input;
  const cx = width / 2;
  const cy = height / 2;

  const degree = new Map<string, number>();
  for (const e of input.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  // Seed positions from the id hash rather than at random, so re-rendering the
  // same graph does not reshuffle it under the reader.
  const nodes: LayoutNode[] = input.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    degree: degree.get(n.id) ?? 0,
    x: cx + (hash01(n.id, 1) - 0.5) * width * 0.8,
    y: cy + (hash01(n.id, 2) - 0.5) * height * 0.8,
  }));

  if (nodes.length === 0) return { nodes, mode: "force" };
  if (nodes.length > FORCE_LIMIT) return { nodes: radial(nodes, cx, cy, Math.min(width, height)), mode: "radial" };

  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const links = input.edges
    .map((e) => ({ a: index.get(e.from), b: index.get(e.to) }))
    .filter((l): l is { a: number; b: number } => l.a !== undefined && l.b !== undefined);

  const iterations = 320;
  const idealEdge = Math.min(width, height) / Math.sqrt(nodes.length) / 1.6;
  const repulsion = idealEdge * idealEdge * 1.4;

  for (let step = 0; step < iterations; step++) {
    // Cooling: big moves early to untangle, small moves late to settle.
    const cooling = 1 - step / iterations;
    const dx = new Float64Array(nodes.length);
    const dy = new Float64Array(nodes.length);

    // Repulsion, every pair. O(n²) is genuinely fine below FORCE_LIMIT.
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (!a) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        if (!b) continue;
        let vx = a.x - b.x;
        let vy = a.y - b.y;
        let d2 = vx * vx + vy * vy;
        if (d2 < 0.01) {
          // Exactly coincident nodes would divide by zero; nudge them apart
          // deterministically rather than randomly.
          vx = (hash01(a.id, 3) - 0.5) * 0.1;
          vy = (hash01(a.id, 4) - 0.5) * 0.1;
          d2 = vx * vx + vy * vy + 0.01;
        }
        const f = repulsion / d2;
        const d = Math.sqrt(d2);
        const ux = (vx / d) * f;
        const uy = (vy / d) * f;
        dx[i] = (dx[i] ?? 0) + ux;
        dy[i] = (dy[i] ?? 0) + uy;
        dx[j] = (dx[j] ?? 0) - ux;
        dy[j] = (dy[j] ?? 0) - uy;
      }
    }

    // Attraction along edges.
    for (const l of links) {
      const a = nodes[l.a];
      const b = nodes[l.b];
      if (!a || !b) continue;
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const d = Math.sqrt(vx * vx + vy * vy) || 0.01;
      const f = (d - idealEdge) * 0.08;
      const ux = (vx / d) * f;
      const uy = (vy / d) * f;
      dx[l.a] = (dx[l.a] ?? 0) + ux;
      dy[l.a] = (dy[l.a] ?? 0) + uy;
      dx[l.b] = (dx[l.b] ?? 0) - ux;
      dy[l.b] = (dy[l.b] ?? 0) - uy;
    }

    const maxStep = idealEdge * 0.6 * cooling + 0.5;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n) continue;
      // Gentle pull to centre keeps disconnected nodes from drifting off-canvas.
      const gx = (cx - n.x) * 0.004;
      const gy = (cy - n.y) * 0.004;
      let mx = (dx[i] ?? 0) * 0.02 + gx;
      let my = (dy[i] ?? 0) * 0.02 + gy;
      const m = Math.sqrt(mx * mx + my * my);
      if (m > maxStep) {
        mx = (mx / m) * maxStep;
        my = (my / m) * maxStep;
      }
      n.x += mx;
      n.y += my;
    }
  }

  // Fit to the viewport with a margin, so the drawing always fills its box
  // regardless of how the simulation happened to spread out.
  return { nodes: fit(nodes, width, height, 40), mode: "force" };
}

/** Concentric rings, one per kind — readable when a force pass would be too slow. */
function radial(nodes: LayoutNode[], cx: number, cy: number, size: number): LayoutNode[] {
  const kinds = [...new Set(nodes.map((n) => n.kind))].sort();
  const byKind = new Map(kinds.map((k) => [k, nodes.filter((n) => n.kind === k)]));
  kinds.forEach((kind, ring) => {
    const group = byKind.get(kind) ?? [];
    const r = (size / 2) * ((ring + 1) / (kinds.length + 0.5));
    group.forEach((n, i) => {
      const a = (i / Math.max(group.length, 1)) * Math.PI * 2;
      n.x = cx + Math.cos(a) * r;
      n.y = cy + Math.sin(a) * r;
    });
  });
  return nodes;
}

function fit(nodes: LayoutNode[], width: number, height: number, margin: number): LayoutNode[] {
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY);
  for (const n of nodes) {
    n.x = margin + (n.x - minX) * scale + (width - margin * 2 - spanX * scale) / 2;
    n.y = margin + (n.y - minY) * scale + (height - margin * 2 - spanY * scale) / 2;
  }
  return nodes;
}
