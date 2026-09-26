// Builds the context graph from what Signet already knows.
//
// Deliberately a DERIVED read model over the existing tables — rules, their
// evidence, design records, increments — rather than a new persisted graph. Two
// reasons. It needs no schema migration, so it ships without touching the
// database. And at this scale the graph is a few thousand nodes that fit in
// memory, which is the same conclusion every serious code-graph project reached:
// Sourcegraph, CodeQL, Glean and Joern all store relationally, in key-value, or
// columnar form, and none uses a graph database as its system of record.
//
// When this needs to become incremental (per-file segments, cross-repo history),
// the shape to persist is a typed adjacency pair — nodes(id, kind, …) and
// edges(src, dst, kind) indexed on (src, kind) and (dst, kind) — NOT a graph
// extension. Apache AGE's own published load tests show variable-length path
// queries at roughly 7 TPS on a ~20k-object graph, which is precisely the query a
// convention graph wants most.

import {
  ContextGraphSchema,
  RuleCheckSchema,
  nodeId,
  type ContextGraph,
  type ConventionKind,
  type GraphEdge,
  type GraphInsight,
  type GraphNode,
} from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";

/** A cap, so a huge estate cannot render an unreadable hairball or a slow page. */
const MAX_NODES = 4000;

/** Evidence refs look like "src/theme.css:12" or "public/logo/logo.svg". */
function splitRef(ref: string): { path: string; line: number | null } {
  const m = /^(.*):(\d+)$/.exec(ref);
  if (m?.[1] !== undefined && m[2] !== undefined) return { path: m[1], line: Number(m[2]) };
  return { path: ref, line: null };
}

/** Rule.kind → the convention vocabulary. They mostly coincide by design. */
function conventionKindOf(ruleKind: string): ConventionKind {
  switch (ruleKind) {
    case "color":
    case "token":
    case "asset":
    case "spacing":
    case "typography":
      return ruleKind;
    default:
      return "token";
  }
}

/**
 * The concrete values a rule is about, read from its compiled check rather than
 * its prose. A rule that cannot compile to a check is advice, not a gate, and its
 * statement is not a reliable source of values — so an unchecked rule contributes
 * no convention nodes rather than a guessed one.
 */
function conventionsOf(rule: { kind: string; checkJson: string | null }): { kind: ConventionKind; value: string }[] {
  if (!rule.checkJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rule.checkJson); // signet-policy-allow: raw-json-parse -- validated on the next line
  } catch {
    return [];
  }
  const check = RuleCheckSchema.safeParse(parsed);
  if (!check.success) return [];

  switch (check.data.type) {
    case "forbid_value":
      return [{ kind: conventionKindOf(rule.kind), value: check.data.value }];
    case "forbid_asset":
      return [{ kind: "asset", value: check.data.assetPath }];
    case "palette_conformance":
      return check.data.allowedHexes.map((hex) => ({ kind: "color" as const, value: hex }));
  }
}

export class ContextGraphService {
  constructor(private readonly db: PrismaClient) {}

  async build(opts: { repo?: string } = {}): Promise<ContextGraph> {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const insights: GraphInsight[] = [];

    const add = (n: GraphNode) => {
      // First writer wins on label, but tags merge — a convention discovered via
      // two routes should carry both provenances.
      const existing = nodes.get(n.id);
      if (existing) {
        nodes.set(n.id, { ...existing, tags: { ...existing.tags, ...n.tags } });
        return;
      }
      nodes.set(n.id, n);
    };

    // ── rules, their conventions, and their evidence ──

    const rules = await this.db.rule.findMany({
      where: {
        ...(opts.repo ? { repoLabel: opts.repo } : {}),
        // Rejected rules are a decision already made; they are noise here.
        status: { in: ["PROPOSED", "CONFIRMED", "DEMOTED"] },
      },
      include: { evidence: true },
      orderBy: { updatedAt: "desc" },
      take: 800,
    });

    const repos = new Set<string>();
    for (const rule of rules) {
      repos.add(rule.repoLabel);
      add({
        id: nodeId.repo(rule.repoLabel),
        kind: "repo",
        label: rule.repoLabel,
        tags: {},
        source: "learner",
      });

      const rid = nodeId.rule(rule.id);
      add({
        id: rid,
        kind: "rule",
        label: rule.statement,
        detail: `${rule.kind} · ${Math.round(rule.confidence * 100)}% confidence · trend ${rule.trend}`,
        tags: { kind: rule.kind, trend: rule.trend, confidence: rule.confidence.toFixed(2) },
        source: "rule",
        status: rule.status,
      });
      edges.push({ from: nodeId.repo(rule.repoLabel), to: rid, kind: "contains" });

      for (const c of conventionsOf(rule)) {
        const cid = nodeId.convention(c.kind, c.value);
        add({
          id: cid,
          kind: "convention",
          label: c.value,
          detail: `${c.kind} convention`,
          tags: { conventionKind: c.kind, trend: rule.trend },
          source: "learner",
          status: rule.trend,
        });
        edges.push({ from: rid, to: cid, kind: "governs" });
      }

      for (const e of rule.evidence) {
        // A git-trend observation is evidence about history, not about a file, so
        // it annotates the rule rather than inventing a file node.
        if (e.kind === "git-trend") {
          const node = nodes.get(rid);
          if (node) nodes.set(rid, { ...node, tags: { ...node.tags, gitTrend: e.detail ?? e.ref } });
          continue;
        }
        const { path, line } = splitRef(e.ref);
        const fid = nodeId.file(rule.repoLabel, path);
        add({
          id: fid,
          kind: "file",
          label: path.split("/").pop() ?? path,
          detail: path,
          tags: { path },
          source: "learner",
        });
        edges.push({ from: nodeId.repo(rule.repoLabel), to: fid, kind: "contains" });
        edges.push({
          from: rid,
          to: fid,
          kind: "evidenced_by",
          detail: line === null ? e.kind : `${e.kind} at line ${line}`,
        });
      }

      if (rule.evidence.length === 0) {
        insights.push({
          kind: "unevidenced_rule",
          nodeId: rid,
          message: `"${rule.statement}" has no evidence behind it — it should not be trusted to gate anything.`,
          severity: "warn",
        });
      }
      if (rule.trend === "dying" || rule.trend === "gone") {
        insights.push({
          kind: "dying_convention",
          nodeId: rid,
          message: `The history says this convention is ${rule.trend}. Confirming a rule for something on the way out locks in the past.`,
          severity: "info",
        });
      }
    }

    // ── designs of record, and what they allow or forbid ──

    const designs = await this.db.designRecord.findMany({ orderBy: { approvedAt: "desc" }, take: 300 });
    const incrementIds = designs.map((d) => d.incrementId);
    const increments = await this.db.increment.findMany({
      where: { id: { in: incrementIds } },
      select: { id: true, title: true, status: true },
    });
    const incrementById = new Map(increments.map((i) => [i.id, i]));

    // Track which designs take which side, to spot a convention under dispute.
    const allowedBy = new Map<string, string[]>();
    const forbiddenBy = new Map<string, string[]>();

    for (const d of designs) {
      let intent: { palette?: string[]; forbiddenColors?: string[]; forbiddenAssets?: string[]; requiredAssets?: string[] };
      try {
        intent = JSON.parse(d.intentJson) as typeof intent; // signet-policy-allow: raw-json-parse -- narrow shape read; written by us
      } catch {
        continue;
      }

      const inc = incrementById.get(d.incrementId);
      const iid = nodeId.increment(d.incrementId);
      add({
        id: iid,
        kind: "increment",
        label: inc?.title ?? "(increment)",
        tags: {},
        source: "work",
        status: inc?.status ?? "unknown",
      });

      const did = nodeId.design(d.incrementId);
      add({
        id: did,
        kind: "design",
        label: `design · ${inc?.title ?? d.incrementId.slice(0, 8)}`,
        detail: `approved by ${d.approvedBy}`,
        tags: { approvedBy: d.approvedBy, source: d.source },
        source: "design",
      });
      edges.push({ from: did, to: iid, kind: "applies_to" });

      const link = (kind: ConventionKind, value: string, allow: boolean) => {
        const cid = nodeId.convention(kind, value);
        add({
          id: cid,
          kind: "convention",
          label: value,
          detail: `${kind} convention`,
          tags: { conventionKind: kind },
          source: "design",
        });
        edges.push({ from: did, to: cid, kind: allow ? "allows" : "forbids" });
        const bucket = allow ? allowedBy : forbiddenBy;
        bucket.set(cid, [...(bucket.get(cid) ?? []), did]);
      };

      for (const hex of intent.palette ?? []) link("color", hex, true);
      for (const hex of intent.forbiddenColors ?? []) link("color", hex, false);
      for (const a of intent.requiredAssets ?? []) link("asset", a, true);
      for (const a of intent.forbiddenAssets ?? []) link("asset", a, false);
    }

    // A convention one design permits and another bans is worth surfacing: it is
    // usually a brand decision that was never actually settled.
    for (const [cid, allowers] of allowedBy) {
      const forbidders = forbiddenBy.get(cid);
      if (forbidders && forbidders.length > 0) {
        insights.push({
          kind: "contested_convention",
          nodeId: cid,
          message: `${nodes.get(cid)?.label ?? cid} is allowed by ${allowers.length} design(s) and forbidden by ${forbidders.length}. One of those approvals is wrong.`,
          severity: "warn",
        });
      }
    }

    // A convention that appears in the codebase but has no CONFIRMED rule is
    // ungoverned: the gate will not defend it, whatever anyone believes.
    const confirmedRuleIds = new Set(rules.filter((r) => r.status === "CONFIRMED").map((r) => nodeId.rule(r.id)));
    const governedByConfirmed = new Set(
      edges.filter((e) => e.kind === "governs" && confirmedRuleIds.has(e.from)).map((e) => e.to),
    );
    for (const n of nodes.values()) {
      if (n.kind !== "convention") continue;
      if (governedByConfirmed.has(n.id)) continue;
      const proposed = edges.some((e) => e.kind === "governs" && e.to === n.id);
      insights.push({
        kind: "ungoverned_convention",
        nodeId: n.id,
        message: proposed
          ? `${n.label} only has a proposed rule — nothing gates it until you confirm one.`
          : `${n.label} has no rule at all, so no gate defends it.`,
        severity: proposed ? "info" : "warn",
      });
    }

    // ── assemble ──

    const all = [...nodes.values()];
    const truncated = all.length > MAX_NODES;
    const kept = truncated ? all.slice(0, MAX_NODES) : all;
    const keptIds = new Set(kept.map((n) => n.id));
    // Drop edges whose endpoints were cut, so the client never gets a dangling ref.
    const keptEdges = edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to));

    const byKind: Record<string, number> = {};
    for (const n of kept) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;

    return ContextGraphSchema.parse({
      nodes: kept,
      edges: dedupeEdges(keptEdges),
      // Cap the insight list too: a thousand "ungoverned" notes is a wall, not a signal.
      insights: insights.slice(0, 200),
      stats: { nodes: kept.length, edges: keptEdges.length, byKind, repos: [...repos] },
      truncated,
    });
  }
}

/** The same claim can be derived twice (two evidence rows in one file); say it once. */
function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const e of edges) {
    const key = `${e.from}|${e.to}|${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
