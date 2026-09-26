// The layout has to be deterministic, bounded, and degrade honestly.
//
// Determinism is the load-bearing property: the same graph must land in the same
// arrangement every render, or the drawing reshuffles under the reader on every
// poll. That rules out Math.random, and this pins it.

import { describe, expect, it } from "vitest";
import { layered, layout } from "./graph-layout.js";

const W = 900;
const H = 560;

function ring(n: number): { nodes: { id: string; kind: string }[]; edges: { from: string; to: string }[] } {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, kind: i % 3 === 0 ? "rule" : "convention" }));
  const edges = Array.from({ length: n }, (_, i) => ({ from: `n${i}`, to: `n${(i + 1) % n}` }));
  return { nodes, edges };
}

describe("graph layout", () => {
  it("is deterministic — the same input lands in exactly the same place", () => {
    const g = ring(40);
    const a = layout({ ...g, width: W, height: H });
    const b = layout({ ...g, width: W, height: H });
    expect(a.nodes.map((n) => [n.id, Math.round(n.x), Math.round(n.y)])).toEqual(
      b.nodes.map((n) => [n.id, Math.round(n.x), Math.round(n.y)]),
    );
  });

  it("keeps every node inside the viewport", () => {
    const { nodes } = layout({ ...ring(80), width: W, height: H });
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(W);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(H);
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("spreads nodes out rather than piling them up", () => {
    const { nodes } = layout({ ...ring(30), width: W, height: H });
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    // A collapsed or degenerate layout would show almost no spread.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(W * 0.4);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(H * 0.3);
  });

  it("records degree, so the drawing can size the hubs", () => {
    const hub = {
      nodes: [{ id: "hub", kind: "rule" }, ...Array.from({ length: 6 }, (_, i) => ({ id: `l${i}`, kind: "file" }))],
      edges: Array.from({ length: 6 }, (_, i) => ({ from: "hub", to: `l${i}` })),
    };
    const { nodes } = layout({ ...hub, width: W, height: H });
    const found = nodes.find((n) => n.id === "hub");
    expect(found?.degree).toBe(6);
    expect(nodes.find((n) => n.id === "l0")?.degree).toBe(1);
  });

  it("falls back to a radial arrangement rather than freezing on a huge graph", () => {
    // Above the force limit an O(n²) pass would block the tab; degrading is the
    // honest answer, and the screen says so when it happens.
    const big = ring(900);
    const res = layout({ ...big, width: W, height: H });
    expect(res.mode).toBe("radial");
    expect(res.nodes).toHaveLength(900);
    for (const n of res.nodes) expect(Number.isFinite(n.x)).toBe(true);
  });

  it("uses the force layout below the limit", () => {
    expect(layout({ ...ring(100), width: W, height: H }).mode).toBe("force");
  });

  it("survives an empty graph and a single node", () => {
    expect(layout({ nodes: [], edges: [], width: W, height: H }).nodes).toEqual([]);
    const one = layout({ nodes: [{ id: "a", kind: "rule" }], edges: [], width: W, height: H });
    expect(one.nodes).toHaveLength(1);
    expect(Number.isFinite(one.nodes[0]?.x ?? NaN)).toBe(true);
  });

  it("survives an edge that points at a node that is not there", () => {
    // Filtering by kind can leave dangling edges; the layout must not crash.
    const res = layout({
      nodes: [{ id: "a", kind: "rule" }],
      edges: [{ from: "a", to: "missing" }],
      width: W,
      height: H,
    });
    expect(res.nodes).toHaveLength(1);
  });

  it("does not put two nodes in exactly the same spot", () => {
    // Coincident nodes would divide by zero in the repulsion pass.
    const { nodes } = layout({
      nodes: Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, kind: "convention" })),
      edges: [],
      width: W,
      height: H,
    });
    const seen = new Set(nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`));
    expect(seen.size).toBe(nodes.length);
  });
});

describe("layered layout", () => {
  const dag = {
    nodes: [
      { id: "repo", kind: "repo" },
      { id: "f1", kind: "file" },
      { id: "f2", kind: "file" },
      { id: "r1", kind: "rule" },
      { id: "c1", kind: "convention" },
      { id: "d1", kind: "design" },
      { id: "i1", kind: "increment" },
    ],
    edges: [
      { from: "repo", to: "f1" },
      { from: "repo", to: "f2" },
      { from: "r1", to: "f1" },
      { from: "r1", to: "f2" },
      { from: "r1", to: "c1" },
      { from: "d1", to: "c1" },
      { from: "d1", to: "i1" },
    ],
  };

  it("orders kinds left to right as the causal chain", () => {
    const { nodes } = layered({ ...dag, width: W, height: H });
    const x = (id: string) => nodes.find((n) => n.id === id)?.x ?? NaN;
    // evidence → rule → convention → design → work reads as a sentence.
    expect(x("repo")).toBeLessThan(x("f1"));
    expect(x("f1")).toBeLessThan(x("r1"));
    expect(x("r1")).toBeLessThan(x("c1"));
    expect(x("c1")).toBeLessThan(x("d1"));
    expect(x("d1")).toBeLessThan(x("i1"));
  });

  it("puts every node of one kind in the same column", () => {
    const { nodes } = layered({ ...dag, width: W, height: H });
    expect(nodes.find((n) => n.id === "f1")?.x).toBe(nodes.find((n) => n.id === "f2")?.x);
  });

  it("is deterministic", () => {
    const a = layered({ ...dag, width: W, height: H });
    const b = layered({ ...dag, width: W, height: H });
    expect(a.nodes.map((n) => [n.id, Math.round(n.x), Math.round(n.y)])).toEqual(
      b.nodes.map((n) => [n.id, Math.round(n.x), Math.round(n.y)]),
    );
  });

  it("stays inside the viewport and spreads across it", () => {
    const { nodes } = layered({ ...dag, width: W, height: H });
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(W);
      expect(n.y).toBeGreaterThan(0);
      expect(n.y).toBeLessThan(H);
    }
  });

  it("compresses to the ranks present, so a filtered graph still fills the box", () => {
    // Hiding files must not leave a visible empty column.
    const noFiles = {
      nodes: dag.nodes.filter((n) => n.kind !== "file"),
      edges: dag.edges.filter((e) => !e.from.startsWith("f") && !e.to.startsWith("f")),
    };
    const { nodes } = layered({ ...noFiles, width: W, height: H });
    const columns = [...new Set(nodes.map((n) => Math.round(n.x)))].sort((a, b) => a - b);
    // Six ranks exist; with files gone five remain (repo, rule, convention,
    // design, increment) and they re-space to fill the width.
    expect(columns).toHaveLength(5);
    // The first and last columns hug the margins.
    expect(columns[0]).toBeLessThan(W * 0.2);
    expect(columns[columns.length - 1]).toBeGreaterThan(W * 0.8);
  });

  it("handles a single kind without dividing by zero", () => {
    const one = {
      nodes: [{ id: "a", kind: "rule" }, { id: "b", kind: "rule" }],
      edges: [],
    };
    const { nodes } = layered({ ...one, width: W, height: H });
    for (const n of nodes) expect(Number.isFinite(n.x)).toBe(true);
    expect(nodes[0]?.x).toBe(nodes[1]?.x);
  });

  it("does not collapse an isolated node to the top", () => {
    const withOrphan = {
      nodes: [...dag.nodes, { id: "lonely", kind: "rule" }],
      edges: dag.edges,
    };
    const { nodes } = layered({ ...withOrphan, width: W, height: H });
    expect(nodes.find((n) => n.id === "lonely")?.y).toBeGreaterThan(0);
  });
});
