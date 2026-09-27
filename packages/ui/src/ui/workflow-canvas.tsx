// A workflow, drawn.
//
// The list version was accurate and told you nothing about shape: "Nightly cart tidy ·
// every day at 03:00 · Tidy cart tests" is a sentence you have to parse. A canvas makes
// the sequence and — more importantly — the STOP visible without reading.
//
// The single most valuable node here is the last one. Automation prepares work and starts
// it, and then it stops, because the merge signature stays human. In a list that is a
// caveat in a paragraph somebody skips. On a canvas it is a terminal node with nothing
// after it, and the chain visibly ends at a human. That is the product's central claim
// made into a picture.
//
// One honest constraint, stated because a node graph normally implies otherwise: the
// engine runs a LINEAR sequence. There is no branching, no condition, no parallel path,
// and no data passed between nodes. So this draws a chain rather than a graph, and does
// not offer edge-drawing — a canvas where you can connect anything to anything, over an
// engine that only walks a list, would promise capability that does not exist. Zapier's
// own builder is a vertical chain for much the same reason.

import { useMemo, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WorkflowTrigger } from "@signet/contracts";

/** Vertical spacing between nodes. Tuned so a four-step chain fits without scrolling. */
const ROW = 116;
const NODE_WIDTH = 300;

export interface CanvasStep {
  recipeId: string;
  recipeName: string;
  /** Shown under the name — usually the first line of what it builds. */
  detail?: string;
  /** A step that cannot run unattended, with the reason. */
  blockedReason?: string;
}

export interface WorkflowCanvasProps {
  trigger: WorkflowTrigger;
  triggerLabel: string;
  steps: CanvasStep[];
  /** Height of the canvas. React Flow needs an explicit one — it cannot infer it. */
  height?: number;
  /** Called when a step node is clicked, for editing. Omit for a read-only canvas. */
  onStepClick?: (recipeId: string) => void;
  onTriggerClick?: () => void;
}

/** What starts the chain. Visually distinct because it is the only input. */
function TriggerNode({ data }: NodeProps): ReactNode {
  const d = data as unknown as { label: string; kind: string; onClick?: () => void };
  return (
    <div
      onClick={d.onClick}
      style={{
        width: NODE_WIDTH,
        border: "1px solid var(--accent-line)",
        background: "var(--accent-quiet)",
        borderRadius: "var(--r-md, 10px)",
        padding: "var(--s3)",
        cursor: d.onClick ? "pointer" : "default",
      }}
    >
      <div style={{ fontSize: "var(--fs-xs)", color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {d.kind === "manual" ? "you start it" : d.kind === "schedule" ? "on a schedule" : "when something happens"}
      </div>
      <div style={{ fontWeight: 500, marginTop: 2 }}>{d.label}</div>
      <Handle type="source" position={Position.Bottom} style={{ background: "var(--accent)" }} />
    </div>
  );
}

/** One recipe in the chain. */
function StepNode({ data }: NodeProps): ReactNode {
  const d = data as unknown as {
    index: number;
    name: string;
    detail?: string;
    blockedReason?: string;
    onClick?: () => void;
  };
  const blocked = Boolean(d.blockedReason);
  return (
    <div
      onClick={d.onClick}
      style={{
        width: NODE_WIDTH,
        border: `1px solid ${blocked ? "var(--err)" : "var(--line)"}`,
        background: blocked ? "var(--err-quiet)" : "var(--panel, var(--bg))",
        borderRadius: "var(--r-md, 10px)",
        padding: "var(--s3)",
        cursor: d.onClick ? "pointer" : "default",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: "var(--line-strong)" }} />
      <div style={{ display: "flex", gap: "var(--s2)", alignItems: "baseline" }}>
        <span style={{ color: "var(--fg-subtle)", fontFamily: "var(--mono)", fontSize: "var(--fs-sm)" }}>
          {d.index}
        </span>
        <span style={{ fontWeight: 500 }}>{d.name}</span>
      </div>
      {d.detail && (
        <div style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)", marginTop: 2 }}>{d.detail}</div>
      )}
      {/* Said on the node itself, not in a legend. A step that can never run unattended
          should be obvious while you are looking at the thing you built. */}
      {d.blockedReason && (
        <div style={{ color: "var(--err)", fontSize: "var(--fs-sm)", marginTop: 4 }}>{d.blockedReason}</div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: "var(--line-strong)" }} />
    </div>
  );
}

/**
 * The end of the chain, and the point of the whole diagram.
 *
 * Nothing comes after this node, and it has no source handle, so the picture cannot be
 * extended past the human. That is deliberate: the shape of the graph is the guarantee.
 */
function SignatureNode(): ReactNode {
  return (
    <div
      style={{
        width: NODE_WIDTH,
        border: "1px dashed var(--warn)",
        borderRadius: "var(--r-md, 10px)",
        padding: "var(--s3)",
        background: "transparent",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: "var(--warn)" }} />
      <div style={{ fontSize: "var(--fs-xs)", color: "var(--warn)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        stops here
      </div>
      <div style={{ fontWeight: 500, marginTop: 2 }}>Waits for you to merge</div>
      <div style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)", marginTop: 2 }}>
        Automation never lands code. This is the signature it does not get.
      </div>
    </div>
  );
}

const NODE_TYPES = { trigger: TriggerNode, step: StepNode, signature: SignatureNode };

export function WorkflowCanvas({
  trigger,
  triggerLabel,
  steps,
  height = 460,
  onStepClick,
  onTriggerClick,
}: WorkflowCanvasProps): ReactNode {
  const { nodes, edges } = useMemo(() => {
    const ns: Node[] = [
      {
        id: "trigger",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { label: triggerLabel, kind: trigger.kind, ...(onTriggerClick ? { onClick: onTriggerClick } : {}) },
        draggable: false,
      },
      ...steps.map((s, i) => ({
        id: `step-${i}`,
        type: "step",
        position: { x: 0, y: (i + 1) * ROW },
        data: {
          index: i + 1,
          name: s.recipeName,
          ...(s.detail ? { detail: s.detail } : {}),
          ...(s.blockedReason ? { blockedReason: s.blockedReason } : {}),
          ...(onStepClick ? { onClick: () => onStepClick(s.recipeId) } : {}),
        },
        // Positions are derived from order, so dragging a node would imply a reordering
        // the engine would not honour. Order is changed with the controls, not the mouse.
        draggable: false,
      })),
      {
        id: "signature",
        type: "signature",
        position: { x: 0, y: (steps.length + 1) * ROW },
        data: {},
        draggable: false,
      },
    ];

    const chain = ["trigger", ...steps.map((_, i) => `step-${i}`), "signature"];
    const es: Edge[] = chain.slice(0, -1).map((from, i) => {
      const to = chain[i + 1] as string;
      const toSignature = to === "signature";
      return {
        id: `${from}->${to}`,
        source: from,
        target: to,
        // The last edge is dashed, matching the terminal node: the chain does not
        // continue on its own, it hands over.
        animated: false,
        style: {
          stroke: toSignature ? "var(--warn)" : "var(--line-strong)",
          strokeWidth: 1.5,
          ...(toSignature ? { strokeDasharray: "4 4" } : {}),
        },
      };
    });

    return { nodes: ns, edges: es };
  }, [trigger.kind, triggerLabel, steps, onStepClick, onTriggerClick]);

  return (
    <div
      style={{
        height,
        border: "1px solid var(--line)",
        borderRadius: "var(--r-sm)",
        overflow: "hidden",
      }}
      // The canvas is a picture of a sequence, and a screen reader should get the
      // sequence rather than a pile of unlabelled boxes.
      role="img"
      aria-label={`Workflow: ${triggerLabel}, then ${steps.map((s) => s.recipeName).join(", then ")}, then waits for you to merge.`}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        // Follows the console's light/dark rather than shipping React Flow's own look.
        colorMode="system"
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        // No edge drawing and no node dragging: the engine walks a list, so a canvas
        // that let you connect anything to anything would be drawing a machine that
        // does not exist.
        nodesConnectable={false}
        edgesFocusable={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
