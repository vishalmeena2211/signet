// The context graph: what Signet has learned, and how it all connects.
//
// Design choices, each taken from prior art rather than invented:
//
// · Node ids are deterministic, human-readable strings — `color:#6609be`,
//   `file:guest-frontend:src/theme.css` — not opaque integers. This is Sourcegraph's
//   central lesson from replacing LSIF with SCIP: opaque ids impose an ordering
//   constraint, break on cycles, and make partial re-indexing hard. Readable
//   deterministic ids make re-indexing an idempotent upsert and make the payload
//   debuggable by eye.
//
// · One node shape with a `kind` discriminator, rather than a type per node. That
//   is CodeQL's dbscheme stance (`case @x.kind of`), and it means a new convention
//   kind is a new enum value rather than a new table.
//
// · Edges are derived from parsers and git, never from a language model. Every
//   GraphRAG-on-code variant moved to deterministic parser-derived edges, and
//   Microsoft cut full-GraphRAG's index cost by 99.9% by deleting the index-time
//   LLM work. An invented edge in a product whose whole pitch is human-confirmed
//   rules would be unfalsifiable noise.
//
// · Analysis results live in the graph beside what they describe, which is why
//   Joern makes FINDING a node type. A rule and the evidence for it are both nodes,
//   so "what governs this colour, and on what evidence" is one traversal.

import { z } from "zod";

/**
 * Node kinds. Deliberately few: this graph answers questions about conventions and
 * their governance, not arbitrary program analysis. The CPG needs ~100 node types
 * because it must answer anything; that breadth is exactly what makes it
 * uncopyable.
 */
export const GraphNodeKindSchema = z.enum([
  "repo", // a learned repository
  "file", // a source file that carries evidence
  "convention", // a colour, token, asset, spacing or type convention
  "rule", // a statement about a convention, which may gate
  "increment", // a unit of work
  "design", // a design of record approved for an increment
]);
export type GraphNodeKind = z.infer<typeof GraphNodeKindSchema>;

export const ConventionKindSchema = z.enum(["color", "token", "asset", "spacing", "typography"]);
export type ConventionKind = z.infer<typeof ConventionKindSchema>;

export const GraphNodeSchema = z.object({
  /** Deterministic and readable, e.g. "convention:color:#6609be". */
  id: z.string().min(1),
  kind: GraphNodeKindSchema,
  /** What to show on the node. */
  label: z.string(),
  /** Longer text for the inspector. */
  detail: z.string().optional(),
  /**
   * Free-form provenance, kept generic on purpose — Joern's TAG/TAGGED_BY escape
   * hatch, so an unforeseen convention kind needs no schema change.
   */
  tags: z.record(z.string(), z.string()).default({}),
  /** Where this came from, so nothing on screen is unattributable. */
  source: z.enum(["learner", "rule", "design", "work"]),
  /** Node status where it has one: a rule's lifecycle, a convention's git trend. */
  status: z.string().optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

/**
 * Edge kinds, each a claim we can actually substantiate:
 * · contains      structural (repo contains file, feature contains increment)
 * · governs       a rule is about a convention
 * · evidenced_by  a rule's evidence points at a file
 * · allows/forbids a design of record permits or bans a convention
 * · applies_to    a design of record belongs to an increment
 * · aliases       a token resolves to another convention (the DTCG alias chain)
 */
export const GraphEdgeKindSchema = z.enum([
  "contains",
  "governs",
  "evidenced_by",
  "allows",
  "forbids",
  "applies_to",
  "aliases",
]);
export type GraphEdgeKind = z.infer<typeof GraphEdgeKindSchema>;

export const GraphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: GraphEdgeKindSchema,
  /** e.g. "src/theme.css:12" or "git-trend: growing". */
  detail: z.string().optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/**
 * Observations the graph makes about itself. These are the point of building it:
 * a convention nobody has a rule about is ungoverned, and a rule with no evidence
 * should not be trusted to gate anything.
 */
export const GraphInsightSchema = z.object({
  kind: z.enum([
    "ungoverned_convention", // used in the codebase, no confirmed rule about it
    "unevidenced_rule", // a rule with no evidence behind it
    "dying_convention", // git says it is on the way out
    "contested_convention", // one design allows it, another forbids it
    "orphan_rule", // a confirmed rule whose convention no longer appears
  ]),
  nodeId: z.string(),
  message: z.string(),
  severity: z.enum(["info", "warn"]),
});
export type GraphInsight = z.infer<typeof GraphInsightSchema>;

export const ContextGraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  insights: z.array(GraphInsightSchema),
  stats: z.object({
    nodes: z.number().int(),
    edges: z.number().int(),
    byKind: z.record(z.string(), z.number().int()),
    /** Repositories represented, so the scope of the graph is never ambiguous. */
    repos: z.array(z.string()),
  }),
  /** True when the graph was capped, so the console never implies completeness. */
  truncated: z.boolean(),
});
export type ContextGraph = z.infer<typeof ContextGraphSchema>;

// ── id construction: one place, so ids stay deterministic ──

export const nodeId = {
  repo: (label: string) => `repo:${label}`,
  file: (repo: string, path: string) => `file:${repo}:${path}`,
  convention: (kind: ConventionKind, value: string) => `convention:${kind}:${value.toLowerCase()}`,
  rule: (id: string) => `rule:${id}`,
  increment: (id: string) => `increment:${id}`,
  design: (incrementId: string) => `design:${incrementId}`,
} as const;
