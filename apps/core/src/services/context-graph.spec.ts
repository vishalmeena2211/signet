// The graph's claims must be substantiated, and its node ids must be stable.
//
// The stability requirement comes straight from Sourcegraph's LSIF post-mortem:
// opaque ids made partial re-indexing hard, so ids here are deterministic strings
// derived from content. If the same convention got two different ids across two
// builds, every insight about it would double.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { nodeId } from "@signet/contracts";
import { PrismaClient } from "../persistence/generated/client.js";
import { setupTestDatabase, truncateAll } from "../testing/test-db.js";
import { ContextGraphService } from "./context-graph.js";

const ctx = await setupTestDatabase("graph");
const enabled = ctx !== null;
const url = ctx?.url ?? "";
const d = enabled ? describe : describe.skip;

const REPO = "cg-spec-repo";
let db: PrismaClient;
let graph: ContextGraphService;
const made = { rules: [] as string[], features: [] as string[], increments: [] as string[] };

async function rule(opts: {
  statement: string;
  kind: string;
  status: string;
  trend?: string;
  check?: unknown;
  evidence?: { ref: string; kind: string; detail?: string }[];
}) {
  const id = randomUUID();
  made.rules.push(id);
  await db.rule.create({
    data: {
      id,
      repoLabel: REPO,
      statement: opts.statement,
      kind: opts.kind,
      confidence: 0.9,
      trend: opts.trend ?? "stable",
      status: opts.status,
      checkJson: opts.check === undefined ? null : JSON.stringify(opts.check),
    },
  });
  for (const e of opts.evidence ?? []) {
    await db.ruleEvidence.create({
      data: { id: randomUUID(), ruleId: id, ref: e.ref, kind: e.kind, ...(e.detail ? { detail: e.detail } : {}) },
    });
  }
  return id;
}

beforeAll(async () => {
  if (!enabled) return;
  db = ctx!.db;
  graph = new ContextGraphService(db);
});

afterAll(async () => {
  if (!enabled) return;
  // Id-free and unconditional: a teardown that deletes remembered rows can
  // miss one, and missing one is how 22 test features ended up on the board.
  await truncateAll(db, url);
  await db.$disconnect();
});

d("context graph (live DB)", () => {
  it("derives conventions from the compiled check, not from the prose", async () => {
    await rule({
      statement: "Never use the legacy navy",
      kind: "color",
      status: "CONFIRMED",
      check: { type: "forbid_value", value: "#010043", allowContexts: [] },
      evidence: [{ ref: "src/theme.css:12", kind: "usage" }],
    });
    // A rule whose statement mentions a colour but has NO compiled check must not
    // contribute a convention: an uncompilable rule is advice, not a gate, and its
    // prose is not a reliable source of values.
    await rule({ statement: "Prefer #ff0000 somewhere, vaguely", kind: "color", status: "PROPOSED" });

    const g = await graph.build({ repo: REPO });
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain(nodeId.convention("color", "#010043"));
    expect(ids).not.toContain(nodeId.convention("color", "#ff0000"));
  });

  it("gives the same convention the same id regardless of letter case", async () => {
    await rule({
      statement: "Brand purple only",
      kind: "color",
      status: "CONFIRMED",
      check: { type: "palette_conformance", allowedHexes: ["#6609BE"], maxDeltaE: 8 },
    });
    const g = await graph.build({ repo: REPO });
    // Upper-case input, lower-case id — so #6609BE and #6609be are one node.
    expect(g.nodes.map((n) => n.id)).toContain("convention:color:#6609be");
  });

  it("is stable across builds: two runs produce identical ids", async () => {
    const a = await graph.build({ repo: REPO });
    const b = await graph.build({ repo: REPO });
    expect(a.nodes.map((n) => n.id).sort()).toEqual(b.nodes.map((n) => n.id).sort());
  });

  it("links a rule to the file its evidence points at, keeping the line number", async () => {
    await rule({
      statement: "Token discipline",
      kind: "token",
      status: "CONFIRMED",
      check: { type: "forbid_value", value: "#123456", allowContexts: [] },
      evidence: [{ ref: "src/tokens.css:42", kind: "declared" }],
    });
    const g = await graph.build({ repo: REPO });
    const fileNode = nodeId.file(REPO, "src/tokens.css");
    expect(g.nodes.map((n) => n.id)).toContain(fileNode);
    const edge = g.edges.find((e) => e.to === fileNode && e.kind === "evidenced_by");
    expect(edge?.detail).toContain("line 42");
  });

  it("treats a git-trend observation as an annotation, not as a phantom file", async () => {
    const id = await rule({
      statement: "Growing token usage",
      kind: "token",
      status: "PROPOSED",
      trend: "growing",
      check: { type: "forbid_value", value: "#abcdef", allowContexts: [] },
      evidence: [{ ref: "6 months", kind: "git-trend", detail: "usage up 4x" }],
    });
    const g = await graph.build({ repo: REPO });
    // No file node called "6 months".
    expect(g.nodes.some((n) => n.kind === "file" && n.label === "6 months")).toBe(false);
    const ruleNode = g.nodes.find((n) => n.id === nodeId.rule(id));
    expect(ruleNode?.tags["gitTrend"]).toBe("usage up 4x");
  });

  it("flags a rule with no evidence as not fit to gate", async () => {
    const id = await rule({ statement: "Asserted without evidence", kind: "color", status: "PROPOSED" });
    const g = await graph.build({ repo: REPO });
    const insight = g.insights.find((i) => i.nodeId === nodeId.rule(id) && i.kind === "unevidenced_rule");
    expect(insight).toBeDefined();
    expect(insight?.severity).toBe("warn");
  });

  it("flags a convention that only a PROPOSED rule covers as ungoverned", async () => {
    await rule({
      statement: "Maybe forbid this",
      kind: "color",
      status: "PROPOSED",
      check: { type: "forbid_value", value: "#bada55", allowContexts: [] },
      evidence: [{ ref: "src/a.css:1", kind: "usage" }],
    });
    const g = await graph.build({ repo: REPO });
    const insight = g.insights.find((i) => i.nodeId === nodeId.convention("color", "#bada55"));
    expect(insight?.kind).toBe("ungoverned_convention");
    // Proposed-but-not-confirmed is information, not an alarm.
    expect(insight?.severity).toBe("info");
    expect(insight?.message).toMatch(/until you confirm/);
  });

  it("never emits an edge pointing at a node it did not include", async () => {
    const g = await graph.build({ repo: REPO });
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it("states the same relationship once, however many times it was derived", async () => {
    await rule({
      statement: "Two pieces of evidence in one file",
      kind: "color",
      status: "CONFIRMED",
      check: { type: "forbid_value", value: "#dupdup", allowContexts: [] },
      evidence: [
        { ref: "src/dup.css:1", kind: "usage" },
        { ref: "src/dup.css:9", kind: "usage" },
      ],
    });
    const g = await graph.build({ repo: REPO });
    const keys = g.edges.map((e) => `${e.from}|${e.to}|${e.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("counts what it returned, so the stats cannot disagree with the drawing", async () => {
    const g = await graph.build({ repo: REPO });
    expect(g.stats.nodes).toBe(g.nodes.length);
    const summed = Object.values(g.stats.byKind).reduce((a, b) => a + b, 0);
    expect(summed).toBe(g.nodes.length);
  });
});
