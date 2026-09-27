// A run, drawn.
//
// The run inspector was accurate and hard to read: a list of phase names, a duration
// column, a token count, five badges. Everything was there and nothing was legible at a
// glance. Three things in particular were invisible no matter how carefully you read:
//
//   · THE FIVE CHECKS RUN AT ONCE. In a list they look sequential, so a slow suite reads
//     as "we are on step four of five" rather than "four finished, tests is still going".
//   · THE REPAIR LOOP IS A LOOP. It was a number — "repairs: 3" — which tells you it
//     happened but not what happened. Drawn, it is an arrow going backwards from the
//     checks to the agent, and the shape explains itself.
//   · WHERE THE TIME WENT. Durations in a column need arithmetic. On the nodes, the one
//     that took four minutes is simply the one that says four minutes.
//
// The last node is the human merge, with no outgoing edge — the same device as the
// workflow canvas. A picture that cannot be extended past the person is a stronger
// statement of the guarantee than a sentence saying so.

import { useMemo, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GateVerdictView, RunPhaseView } from "@signet/contracts";
import { formatDuration } from "./format.js";

/** The phases a run walks, in order, with the words the screen uses. */
const PHASES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "ASSEMBLE_PACK", label: "Gather context" },
  { key: "CREATE_WORKSPACE", label: "Clean copy of the repo" },
  { key: "AGENT_PLAN", label: "Plan the change" },
  { key: "SCOPE_CHECK", label: "Check the plan's files" },
  { key: "AGENT_IMPLEMENT", label: "Write the code" },
  { key: "GATES", label: "Run the checks" },
  { key: "FINALIZE", label: "Wrap up" },
];

const GATE_LABEL: Record<string, string> = {
  typecheck: "Types",
  lint: "Lint",
  tests: "Tests",
  conformance: "Design",
  rules: "Conventions",
};

type PhaseState = "done" | "running" | "failed" | "pending";

const TONE: Record<PhaseState, { border: string; bg: string; text: string }> = {
  done: { border: "var(--line)", bg: "transparent", text: "var(--fg-muted)" },
  running: { border: "var(--accent-line)", bg: "var(--accent-quiet)", text: "var(--accent)" },
  failed: { border: "var(--err)", bg: "var(--err-quiet)", text: "var(--err)" },
  pending: { border: "var(--line)", bg: "transparent", text: "var(--fg-subtle)" },
};

const COL = 250;
const ROW = 86;

function PhaseNode({ data }: NodeProps): ReactNode {
  const d = data as unknown as { label: string; state: PhaseState; detail?: string };
  const tone = TONE[d.state];
  return (
    <div
      style={{
        width: 210,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        borderRadius: "var(--r-sm)",
        padding: "var(--s2) var(--s3)",
        // Pending phases recede rather than disappear: the shape of the whole pipeline
        // should be visible from the first second, not assembled as it goes.
        opacity: d.state === "pending" ? 0.55 : 1,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "var(--line-strong)" }} />
      <div style={{ color: tone.text, fontWeight: d.state === "running" ? 600 : 400 }}>{d.label}</div>
      {d.detail && (
        <div style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)", fontFamily: "var(--mono)" }}>
          {d.detail}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={{ background: "var(--line-strong)" }} />
    </div>
  );
}

/** One check. Small, because five of them stack vertically beside the gates phase. */
function GateNode({ data }: NodeProps): ReactNode {
  const d = data as unknown as { label: string; outcome: string; count: number };
  const state: PhaseState =
    d.outcome === "pass"
      ? "done"
      : d.outcome === "fail"
        ? "failed"
        : d.outcome === "running"
          ? "running"
          : "pending";
  const tone = TONE[state];
  return (
    <div
      style={{
        width: 150,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        borderRadius: "var(--r-sm)",
        padding: "4px var(--s2)",
        fontSize: "var(--fs-sm)",
        opacity: d.outcome === "skipped" ? 0.45 : 1,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "var(--line-strong)" }} />
      <span style={{ color: tone.text }}>{d.label}</span>
      <span style={{ color: "var(--fg-subtle)", float: "right", fontSize: "var(--fs-xs)" }}>
        {d.outcome === "skipped" ? "n/a" : d.outcome}
        {d.count > 0 ? ` · ${d.count}` : ""}
      </span>
    </div>
  );
}

/** The end. No source handle, so the drawing cannot continue past the person. */
function MergeNode({ data }: NodeProps): ReactNode {
  const d = data as unknown as { reached: boolean; merged: boolean };
  return (
    <div
      style={{
        width: 210,
        border: `1px ${d.merged ? "solid" : "dashed"} ${d.merged ? "var(--ok)" : "var(--warn)"}`,
        borderRadius: "var(--r-sm)",
        padding: "var(--s2) var(--s3)",
        opacity: d.reached ? 1 : 0.55,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "var(--warn)" }} />
      <div style={{ color: d.merged ? "var(--ok)" : "var(--warn)", fontWeight: 500 }}>
        {d.merged ? "You merged it" : "Waits for you to merge"}
      </div>
      <div style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)" }}>
        {d.merged ? "landed on your branch" : "Signet stops here"}
      </div>
    </div>
  );
}

const NODE_TYPES = { phase: PhaseNode, gate: GateNode, merge: MergeNode };

export interface RunCanvasProps {
  phases: RunPhaseView[];
  verdicts: GateVerdictView[];
  /** How many times the check suite ran. More than one means a repair happened. */
  gateRounds: number;
  /** Terminal state of the increment, so the last node can tell merged from waiting. */
  incrementStatus: string;
  height?: number;
}

export function RunCanvas({
  phases,
  verdicts,
  gateRounds,
  incrementStatus,
  height = 520,
}: RunCanvasProps): ReactNode {
  const { nodes, edges } = useMemo(() => {
    // Latest attempt per phase: a repaired run has several rows for the same phase and
    // the newest is the one that describes where things stand.
    const byPhase = new Map<string, RunPhaseView>();
    for (const p of phases) {
      const prev = byPhase.get(p.phase);
      if (!prev || Date.parse(p.enteredAt) >= Date.parse(prev.enteredAt)) byPhase.set(p.phase, p);
    }

    const ns: Node[] = [];
    const es: Edge[] = [];

    PHASES.forEach((ph, i) => {
      const row = byPhase.get(ph.key);
      const state: PhaseState = !row
        ? "pending"
        : row.completedAt === null
          ? "running"
          : "done";
      ns.push({
        id: ph.key,
        type: "phase",
        position: { x: i * COL, y: 0 },
        draggable: false,
        data: {
          label: ph.label,
          state,
          ...(row?.durationMs != null
            ? { detail: formatDuration(row.durationMs) }
            : state === "running"
              ? { detail: "running…" }
              : {}),
        },
      });
      if (i > 0) {
        const from = PHASES[i - 1]?.key as string;
        es.push({
          id: `${from}->${ph.key}`,
          source: from,
          target: ph.key,
          style: { stroke: "var(--line-strong)", strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "var(--line-strong)" },
        });
      }
    });

    // The checks, hanging off the gates phase. Drawn as siblings because they run
    // CONCURRENTLY — in a list they read as sequential, which misrepresents both the
    // timing and what a slow one means.
    const gatesIndex = PHASES.findIndex((p) => p.key === "GATES");
    const byGate = new Map(verdicts.map((v) => [v.gate, v]));
    const gateNames = ["typecheck", "lint", "tests", "conformance", "rules"];
    gateNames.forEach((g, i) => {
      const v = byGate.get(g as GateVerdictView["gate"]);
      ns.push({
        id: `gate-${g}`,
        type: "gate",
        // Offset below the spine, centred on the gates column.
        position: { x: gatesIndex * COL + 20, y: ROW + i * 40 },
        draggable: false,
        data: {
          label: GATE_LABEL[g] ?? g,
          outcome: v?.outcome ?? "pending",
          count: v?.findings.length ?? 0,
        },
      });
      es.push({
        id: `GATES->gate-${g}`,
        source: "GATES",
        target: `gate-${g}`,
        style: {
          stroke: v?.outcome === "fail" ? "var(--err)" : "var(--line)",
          strokeWidth: 1,
        },
      });
    });

    // The repair loop, as a loop. "repairs: 3" tells you it happened; an arrow going
    // backwards from the checks to the agent tells you what happened.
    if (gateRounds > 1) {
      es.push({
        id: "repair-loop",
        source: "GATES",
        target: "AGENT_IMPLEMENT",
        label: `sent back ${gateRounds - 1}×`,
        labelStyle: { fill: "var(--warn)", fontSize: 11 },
        labelBgStyle: { fill: "var(--bg)" },
        style: { stroke: "var(--warn)", strokeWidth: 1.5, strokeDasharray: "4 3" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--warn)" },
      });
    }

    const merged = incrementStatus === "MERGED";
    const reached = merged || incrementStatus === "AWAITING_SIGNATURE";
    ns.push({
      id: "merge",
      type: "merge",
      position: { x: PHASES.length * COL, y: 0 },
      draggable: false,
      data: { reached, merged },
    });
    es.push({
      id: "FINALIZE->merge",
      source: "FINALIZE",
      target: "merge",
      style: {
        stroke: merged ? "var(--ok)" : "var(--warn)",
        strokeWidth: 1.5,
        strokeDasharray: merged ? undefined : "4 4",
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: merged ? "var(--ok)" : "var(--warn)" },
    });

    return { nodes: ns, edges: es };
  }, [phases, verdicts, gateRounds, incrementStatus]);

  const spoken = useMemo(() => {
    const done = PHASES.filter((p) => phases.some((q) => q.phase === p.key && q.completedAt !== null)).length;
    const failedGates = verdicts.filter((v) => v.outcome === "fail").map((v) => GATE_LABEL[v.gate] ?? v.gate);
    return [
      `Run pipeline: ${done} of ${PHASES.length} phases complete.`,
      gateRounds > 1 ? `The checks ran ${gateRounds} times, so work was sent back ${gateRounds - 1} times.` : "",
      failedGates.length > 0 ? `Failing: ${failedGates.join(", ")}.` : "",
      incrementStatus === "MERGED" ? "Merged." : "Ends waiting for you to merge.",
    ]
      .filter(Boolean)
      .join(" ");
  }, [phases, verdicts, gateRounds, incrementStatus]);

  return (
    <div
      style={{ height, border: "1px solid var(--line)", borderRadius: "var(--r-sm)", overflow: "hidden" }}
      // The sentence a screen reader gets. A pile of unlabelled boxes is not a diagram.
      role="img"
      aria-label={spoken}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        colorMode="system"
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesConnectable={false}
        edgesFocusable={false}
        // Positions are derived from the phase order, so dragging would suggest a
        // rearrangement the runtime would not honour.
        nodesDraggable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
