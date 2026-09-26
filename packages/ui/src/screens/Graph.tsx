// The context graph: what Signet has learned, and what it notices about itself.
//
// The insights are listed FIRST and the drawing second, on purpose. A
// force-directed graph is a good instrument for exploring and a poor one for
// answering a question — "which conventions has nothing confirmed to defend them"
// is a list, not a picture. The picture earns its place by showing shape and
// neighbourhood once you already know what you are looking for.

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ContextGraph, GraphInsight, GraphNode } from "@signet/contracts";
import { api } from "../api.js";
import { navigate } from "../router.js";
import { Badge, Button, Card, Detail, Dot, Row, SectionTitle, Segmented, Stack, type Tone } from "../ui/primitives.js";
import { Drawer, EmptyState, QueryState } from "../ui/feedback.js";
import { layered, layout } from "./graph-layout.js";

/** One colour per node kind, from the token layer so both themes work. */
const KIND: Record<string, { tone: Tone; label: string; help: string }> = {
  repo: { tone: "neutral", label: "Repository", help: "A repository Signet has learned from." },
  file: { tone: "idle", label: "File", help: "A file that carries evidence for a rule." },
  convention: { tone: "accent", label: "Convention", help: "A colour, token or asset the codebase uses." },
  rule: { tone: "ok", label: "Rule", help: "A statement about a convention, which may gate." },
  increment: { tone: "run", label: "Increment", help: "A unit of work." },
  design: { tone: "warn", label: "Design", help: "An approved design of record." },
};

const EDGE_STYLE: Record<string, { stroke: string; dash?: string }> = {
  contains: { stroke: "var(--line-strong)" },
  governs: { stroke: "var(--ok)" },
  evidenced_by: { stroke: "var(--line-strong)", dash: "3 3" },
  allows: { stroke: "var(--accent)" },
  forbids: { stroke: "var(--err)", dash: "4 2" },
  applies_to: { stroke: "var(--warn)" },
  aliases: { stroke: "var(--run)", dash: "2 2" },
};

const INSIGHT_LABEL: Record<GraphInsight["kind"], string> = {
  ungoverned_convention: "Ungoverned",
  unevidenced_rule: "No evidence",
  dying_convention: "On the way out",
  contested_convention: "Contested",
  orphan_rule: "Orphaned",
};

const VIEW_W = 900;
const VIEW_H = 560;

export function Graph() {
  const q = useQuery({ queryKey: ["graph"], queryFn: () => api.graph(), refetchInterval: 30_000 });
  return (
    <QueryState isPending={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeletonRows={5}>
      {q.data && (q.data.nodes.length === 0 ? <Empty /> : <Loaded graph={q.data} />)}
    </QueryState>
  );
}

function Empty() {
  return (
    <EmptyState
      title="Nothing learned yet"
      body="The graph is built from mined conventions, the rules about them, and the designs you have approved. Learn a repository and it fills in."
      action={<Button variant="primary" onClick={() => navigate({ view: "constitution" })}>Learn a repository</Button>}
    />
  );
}

function Loaded({ graph }: { graph: ContextGraph }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set(["file"])); // files are the noisiest
  const [selected, setSelected] = useState<string | null>(null);
  const [insightFilter, setInsightFilter] = useState<"all" | "warn">("all");
  // Layered is the default: the data is a DAG (file evidences rule governs
  // convention permitted by design for an increment), and ranks show that flow
  // where a force pass would scramble it into a blob.
  const [mode, setMode] = useState<"layered" | "force">("layered");
  // The single most effective declutter control: dragging this from 1 to 2 usually
  // removes every leaf and leaves the actual structure.
  const [minDegree, setMinDegree] = useState(0);

  const visible = useMemo(() => {
    const kept = graph.nodes.filter((n) => !hidden.has(n.kind));
    const keptIds = new Set(kept.map((n) => n.id));
    const edges = graph.edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to));
    if (minDegree <= 0) return { nodes: kept, edges };
    // Degree is counted AFTER the kind filter, so the number means what is on
    // screen rather than what is in the database.
    const deg = new Map<string, number>();
    for (const e of edges) {
      deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
      deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    }
    const nodes = kept.filter((n) => (deg.get(n.id) ?? 0) >= minDegree);
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  }, [graph, hidden, minDegree]);

  const positioned = useMemo(() => {
    const input = { nodes: visible.nodes, edges: visible.edges, width: VIEW_W, height: VIEW_H };
    return mode === "layered" ? layered(input) : layout(input);
  }, [visible, mode]);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const posById = useMemo(() => new Map(positioned.nodes.map((n) => [n.id, n])), [positioned.nodes]);

  const insights = insightFilter === "warn" ? graph.insights.filter((i) => i.severity === "warn") : graph.insights;
  const warnCount = graph.insights.filter((i) => i.severity === "warn").length;

  /** The selected node's immediate neighbourhood, for the inspector and for dimming. */
  const neighbourhood = useMemo(() => {
    if (!selected) return null;
    const out = graph.edges.filter((e) => e.from === selected);
    const inn = graph.edges.filter((e) => e.to === selected);
    const ids = new Set([selected, ...out.map((e) => e.to), ...inn.map((e) => e.from)]);
    return { out, inn, ids };
  }, [selected, graph.edges]);

  return (
    <Stack gap="var(--s5)">
      <Row justify="space-between" wrap gap="var(--s3)">
        <Row gap="var(--s4)" wrap>
          {Object.entries(graph.stats.byKind).map(([kind, n]) => (
            <Detail key={kind} label={KIND[kind]?.label ?? kind}>
              <span className="num">{n}</span>
            </Detail>
          ))}
          <Detail label="Edges">
            <span className="num">{graph.stats.edges}</span>
          </Detail>
        </Row>
        <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
          {graph.stats.repos.join(", ") || "no repository"}
          {graph.truncated && " · capped for display"}
        </span>
      </Row>

      {/* Insights first: these are answers, not exploration. */}
      <Stack gap="var(--s3)">
        <SectionTitle
          action={
            <Segmented
              options={[
                { value: "all", label: "All", count: graph.insights.length },
                { value: "warn", label: "Needs attention", count: warnCount },
              ]}
              value={insightFilter}
              onChange={setInsightFilter}
            />
          }
        >
          What the graph notices
        </SectionTitle>
        {insights.length === 0 ? (
          <Card padding="var(--s3)">
            <Row gap="var(--s2)">
              <Dot tone="ok" />
              <span>Every convention in the graph has a confirmed rule behind it.</span>
            </Row>
          </Card>
        ) : (
          <Card padding="0">
            <Stack gap="0">
              {insights.slice(0, 40).map((i, idx) => (
                <Row
                  key={`${i.kind}-${i.nodeId}-${idx}`}
                  gap="var(--s3)"
                  justify="space-between"
                  style={{ padding: "var(--s2) var(--s3)", borderTop: idx === 0 ? "none" : "1px solid var(--line)" }}
                >
                  <Row gap="var(--s3)" style={{ minWidth: 0 }}>
                    <Badge tone={i.severity === "warn" ? "warn" : "idle"}>{INSIGHT_LABEL[i.kind]}</Badge>
                    <span style={{ minWidth: 0 }}>{i.message}</span>
                  </Row>
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => setSelected(i.nodeId)}
                    title="Show this in the graph"
                  >
                    show
                  </Button>
                </Row>
              ))}
              {insights.length > 40 && (
                <Row style={{ padding: "var(--s2) var(--s3)", borderTop: "1px solid var(--line)" }}>
                  <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
                    {insights.length - 40} more not shown.
                  </span>
                </Row>
              )}
            </Stack>
          </Card>
        )}
      </Stack>

      {/* Then the picture. */}
      <Stack gap="var(--s3)">
        <SectionTitle
          action={
            <Row gap="var(--s2)" wrap>
              {Object.keys(KIND).map((kind) => {
                const off = hidden.has(kind);
                const count = graph.stats.byKind[kind] ?? 0;
                if (count === 0) return null;
                return (
                  <button
                    key={kind}
                    onClick={() =>
                      setHidden((h) => {
                        const next = new Set(h);
                        if (next.has(kind)) next.delete(kind);
                        else next.add(kind);
                        return next;
                      })
                    }
                    title={`${KIND[kind]?.help ?? kind} — click to ${off ? "show" : "hide"}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      background: "none",
                      border: "1px solid var(--line)",
                      borderRadius: "var(--r-sm)",
                      padding: "2px 6px",
                      fontSize: "var(--fs-xs)",
                      cursor: "pointer",
                      opacity: off ? 0.4 : 1,
                      color: "var(--fg-muted)",
                    }}
                  >
                    <Dot tone={KIND[kind]?.tone ?? "neutral"} />
                    {KIND[kind]?.label ?? kind} {count}
                  </button>
                );
              })}
            </Row>
          }
        >
          Shape
        </SectionTitle>

        <Row justify="space-between" wrap gap="var(--s3)">
          <Segmented
            options={[
              { value: "layered", label: "Layered" },
              { value: "force", label: "Force" },
            ]}
            value={mode}
            onChange={setMode}
          />
          <Row gap="var(--s2)">
            <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
              min connections
            </span>
            <input
              type="range"
              min={0}
              max={4}
              value={minDegree}
              onChange={(e) => setMinDegree(Number(e.target.value))}
              title="Hide weakly connected nodes. Dragging this to 2 usually removes every leaf and leaves the structure."
              style={{ width: 110 }}
            />
            <Badge tone={minDegree > 0 ? "accent" : "idle"}>
              {minDegree === 0 ? "all" : `${minDegree}+`}
            </Badge>
            <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }} className="num">
              {visible.nodes.length} shown
            </span>
          </Row>
        </Row>

        <Card padding="0" style={{ overflow: "hidden" }}>
          <GraphCanvas
            nodes={positioned.nodes}
            edges={visible.edges}
            byId={byId}
            selected={selected}
            highlight={neighbourhood?.ids ?? null}
            onSelect={setSelected}
          />
          <Row
            justify="space-between"
            wrap
            gap="var(--s3)"
            style={{ padding: "var(--s2) var(--s3)", borderTop: "1px solid var(--line)" }}
          >
            <Row gap="var(--s3)" wrap style={{ fontSize: "var(--fs-xs)", color: "var(--fg-subtle)" }}>
              {Object.entries(EDGE_STYLE).map(([kind, s]) => (
                <Row key={kind} gap="4px">
                  <svg width="16" height="6" aria-hidden>
                    <line x1="0" y1="3" x2="16" y2="3" stroke={s.stroke} strokeWidth="1.5" strokeDasharray={s.dash} />
                  </svg>
                  {kind.replace(/_/g, " ")}
                </Row>
              ))}
            </Row>
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--fg-subtle)" }}>
              {positioned.mode === "radial"
                ? "too many nodes for a force layout — arranged by kind instead; hide a kind or raise the minimum to get it back"
                : positioned.mode === "layered"
                  ? "left to right: evidence → rule → convention → design → work · size = how connected"
                  : "size = how connected · click a node to inspect it"}
            </span>
          </Row>
        </Card>
      </Stack>

      <NodeInspector
        node={selected ? (byId.get(selected) ?? null) : null}
        neighbourhood={neighbourhood}
        byId={byId}
        posById={posById}
        onClose={() => setSelected(null)}
        onSelect={setSelected}
      />
    </Stack>
  );
}

function GraphCanvas({
  nodes,
  edges,
  byId,
  selected,
  highlight,
  onSelect,
}: {
  nodes: ReturnType<typeof layered>["nodes"];
  edges: readonly { from: string; to: string; kind: string; detail?: string | undefined }[];
  byId: Map<string, GraphNode>;
  selected: string | null;
  highlight: Set<string> | null;
  onSelect: (id: string | null) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const pos = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const svgRef = useRef<SVGSVGElement>(null);

  const maxDegree = Math.max(1, ...nodes.map((n) => n.degree));
  const radiusOf = (degree: number) => 3.5 + Math.sqrt(degree / maxDegree) * 8;

  /** Label only what is worth reading: the hub nodes, the hovered, the selected. */
  const labelled = useMemo(() => {
    const sorted = [...nodes].sort((a, b) => b.degree - a.degree);
    return new Set(sorted.slice(0, 18).map((n) => n.id));
  }, [nodes]);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      style={{ width: "100%", height: "auto", display: "block", background: "var(--bg)" }}
      role="img"
      aria-label={`Context graph: ${nodes.length} nodes, ${edges.length} relationships`}
      onClick={(e) => {
        // Clicking the background clears the selection.
        if (e.target === svgRef.current) onSelect(null);
      }}
    >
      <g>
        {edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const style = EDGE_STYLE[e.kind] ?? { stroke: "var(--line)" };
          // Dim everything outside the selected neighbourhood: focus+context is
          // what keeps a graph this size readable.
          const dim = highlight !== null && !(highlight.has(e.from) && highlight.has(e.to));
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={style.stroke}
              strokeWidth={dim ? 0.5 : 1.2}
              strokeDasharray={style.dash}
              opacity={dim ? 0.12 : 0.55}
            />
          );
        })}
      </g>
      <g>
        {nodes.map((n) => {
          const meta = byId.get(n.id);
          const tone = KIND[n.kind]?.tone ?? "neutral";
          const r = radiusOf(n.degree);
          const isSelected = n.id === selected;
          const dim = highlight !== null && !highlight.has(n.id);
          const showLabel = !dim && (isSelected || n.id === hover || labelled.has(n.id));
          return (
            <g
              key={n.id}
              transform={`translate(${n.x} ${n.y})`}
              onClick={() => onSelect(n.id)}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: "pointer" }}
            >
              <title>{`${KIND[n.kind]?.label ?? n.kind}: ${meta?.label ?? n.id}`}</title>
              <circle
                r={isSelected ? r + 3 : r}
                fill={`var(--${toneVar(tone)})`}
                opacity={dim ? 0.18 : 0.9}
                stroke={isSelected ? "var(--fg)" : "var(--bg)"}
                strokeWidth={isSelected ? 2 : 1}
              />
              {showLabel && (
                <text
                  x={r + 4}
                  y={3.5}
                  fill="var(--fg-muted)"
                  fontSize="9"
                  style={{ pointerEvents: "none", fontFamily: "var(--font)" }}
                >
                  {truncate(meta?.label ?? n.id, 26)}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/** Tone → the CSS variable name. Keeps colour in the token layer, not in JS. */
function toneVar(tone: Tone): string {
  return tone === "neutral" ? "fg-muted" : tone;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function NodeInspector({
  node,
  neighbourhood,
  byId,
  posById,
  onClose,
  onSelect,
}: {
  node: GraphNode | null;
  neighbourhood: { out: readonly { to: string; kind: string; detail?: string | undefined }[]; inn: readonly { from: string; kind: string; detail?: string | undefined }[] } | null;
  byId: Map<string, GraphNode>;
  posById: Map<string, unknown>;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  if (!node) return null;
  const meta = KIND[node.kind];
  const hiddenFromCanvas = !posById.has(node.id);

  return (
    <Drawer
      open
      onClose={onClose}
      title={node.label}
      subtitle={`${meta?.label ?? node.kind}${node.status ? ` · ${node.status}` : ""}`}
      width={620}
    >
      <Stack gap="var(--s4)">
        {hiddenFromCanvas && (
          <Card tone="warn" padding="var(--s2)">
            <span style={{ color: "var(--warn)", fontSize: "var(--fs-sm)" }}>
              This node's kind is currently hidden in the drawing — un-hide {meta?.label ?? node.kind} to see it in place.
            </span>
          </Card>
        )}

        {node.detail && <span style={{ color: "var(--fg-muted)" }}>{node.detail}</span>}

        <Row gap="var(--s5)" wrap>
          <Detail label="Kind">{meta?.label ?? node.kind}</Detail>
          <Detail label="Learned from">{node.source}</Detail>
          {node.status && <Detail label="Status">{node.status}</Detail>}
        </Row>

        {Object.keys(node.tags).length > 0 && (
          <Stack gap="var(--s2)">
            <SectionTitle>Attributes</SectionTitle>
            <Row gap="var(--s2)" wrap>
              {Object.entries(node.tags).map(([k, v]) => (
                <Badge key={k} mono>
                  {k}: {v}
                </Badge>
              ))}
            </Row>
          </Stack>
        )}

        {neighbourhood && (
          <Stack gap="var(--s2)">
            <SectionTitle>Connections</SectionTitle>
            <Card padding="0">
              <Stack gap="0">
                {[
                  ...neighbourhood.out.map((e) => ({ dir: "→" as const, id: e.to, kind: e.kind, detail: e.detail })),
                  ...neighbourhood.inn.map((e) => ({ dir: "←" as const, id: e.from, kind: e.kind, detail: e.detail })),
                ].map((e, i) => {
                  const other = byId.get(e.id);
                  return (
                    <Row
                      key={`${e.dir}${e.id}${e.kind}${i}`}
                      justify="space-between"
                      gap="var(--s3)"
                      style={{ padding: "var(--s2) var(--s3)", borderTop: i === 0 ? "none" : "1px solid var(--line)" }}
                    >
                      <Row gap="var(--s2)" style={{ minWidth: 0 }}>
                        <span style={{ color: "var(--fg-subtle)", fontFamily: "var(--mono)" }}>{e.dir}</span>
                        <Badge mono>{e.kind.replace(/_/g, " ")}</Badge>
                        <button
                          onClick={() => onSelect(e.id)}
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            color: "var(--accent)",
                            cursor: "pointer",
                            textAlign: "left",
                            minWidth: 0,
                          }}
                        >
                          {other?.label ?? e.id}
                        </button>
                      </Row>
                      {e.detail && (
                        <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)", flex: "0 0 auto" }}>
                          {e.detail}
                        </span>
                      )}
                    </Row>
                  );
                })}
                {neighbourhood.out.length + neighbourhood.inn.length === 0 && (
                  <Row style={{ padding: "var(--s3)" }}>
                    <span style={{ color: "var(--fg-muted)" }}>Nothing connects to this node.</span>
                  </Row>
                )}
              </Stack>
            </Card>
          </Stack>
        )}

        {node.kind === "rule" && (
          <Button onClick={() => navigate({ view: "constitution" })}>Open the constitution →</Button>
        )}
        {node.kind === "increment" && (
          <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
            Find this increment under Work to act on it.
          </span>
        )}
      </Stack>
    </Drawer>
  );
}
