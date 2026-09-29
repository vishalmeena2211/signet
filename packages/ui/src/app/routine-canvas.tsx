// Routines, drawn as a canvas (frames 30, 32 and 33).
//
// The same routine as the sentence view, drawn: one trigger, then the recipes it runs in
// order, each stopping at your seal. The board is React Flow, but the layout is not
// stored: the order of the recipes IS the routine, so the cards are always laid out from
// it, top to bottom. Dragging a card reorders; dropping from the palette inserts.
//
// Two things are drawn over the same cards rather than on another screen: a loop, when
// the trigger is an event the routine's own work can cause (32), and a past firing, with
// what each recipe did and what is now waiting for you (33).

import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import type { Recipe, RoutineFiring, Workflow, WorkflowTrigger } from "@signet/contracts";
import { api } from "../api.js";
import { Icon } from "./icons.js";
import { navigate } from "./router.js";
import { clock, money } from "./format.js";
import { EVENT_WORDS, SELF_CAUSED, hm, lowerFirst, triggerWords } from "./routine-words.js";

// React Flow draws wires and arrowheads as SVG attributes, which cannot read CSS
// variables, so these repeat three tokens from signet.css.
const LINE_2 = "#34343B";
const LINE_1 = "#26262B";
const SEAL = "#E6A53A";

const CARD_W = 210;
const CARD_H = 80;
const STEP = 112;

// ── the board, as data: pure, so the tests can pin it ──

export type CardKind = "when" | "do" | "end" | "ghost";
export interface CardData extends Record<string, unknown> {
  kind: CardKind;
  lab?: string;
  title?: string;
  sub?: string;
  /** The small mark in the seal colour: "your seal", "at your seal". */
  pip?: string | undefined;
  yours?: boolean;
  muted?: boolean;
  loopIn?: boolean;
  loopOut?: boolean;
  /** The blank board's first slot: nothing comes before it. */
  first?: boolean;
}

export interface RoutineShape {
  trigger: WorkflowTrigger | null;
  steps: Array<{ id: string; recipeId: string; recipeName: string }>;
}

/** Where each card goes and which wires join them. The order of the steps is the layout. */
export function routineGraph(opts: {
  routine: RoutineShape;
  recipes: Recipe[];
  selected: string | null;
  dropping: boolean;
  firing: RoutineFiring | null;
}): { nodes: Array<Node<CardData>>; edges: Edge[] } {
  const { routine, recipes, selected, dropping, firing } = opts;
  const nodes: Array<Node<CardData>> = [];
  const edges: Edge[] = [];
  const at = (i: number) => i * STEP;
  const loop = routine.trigger?.kind === "event" && SELF_CAUSED.has(routine.trigger.event) && routine.steps.length > 0 && !firing;

  if (!routine.trigger) {
    nodes.push(card("ghost-when", 0, at(0), { kind: "ghost", sub: "Drag a trigger here to start", first: true }, { h: 56 }));
    return { nodes, edges };
  }

  const [prefix, slot] = triggerWords(routine.trigger);
  nodes.push(
    card("when", 0, at(0), {
      kind: "when",
      lab: "When",
      title: routine.trigger.kind === "event" ? cap(slot) : `${prefix} ${slot}`,
      sub: firing ? firedLine(firing) : triggerKind(routine.trigger),
      muted: !!firing,
      loopIn: loop,
    }, { selected: selected === "when" }),
  );

  let prev = "when";
  let stopped = false;
  routine.steps.forEach((s, i) => {
    const recipe = recipes.find((r) => r.id === s.recipeId);
    const id = `step:${s.id}`;
    const base: CardData = {
      kind: "do",
      lab: i === 0 ? "Do" : "Then",
      title: s.recipeName,
      sub: `${recipe?.repoLabel ?? "the configured repo"} · first step only`,
      pip: "your seal",
      loopOut: loop && i === routine.steps.length - 1,
    };
    if (firing) {
      const did = firing.steps.find((f) => f.stepId === s.id) ?? (firing.steps.some((f) => f.stepId) ? undefined : firing.steps[i]);
      Object.assign(base, overlay(did, stopped));
      if (did?.error) stopped = true;
    }
    nodes.push(card(id, 0, at(i + 1), base, { selected: selected === id }));
    edges.push(wire(prev, id, i === 0 ? undefined : "then"));
    prev = id;
  });

  if (dropping) {
    nodes.push(card("ghost", 0, at(routine.steps.length + 1), { kind: "ghost", sub: routine.steps.length === 0 ? "Drop a recipe here" : `Drop here to run it after “${routine.steps.at(-1)?.recipeName}”` }, { h: 56 }));
    edges.push(wire(prev, "ghost", undefined, { dash: true }));
    prev = "ghost";
  }
  const endY = at(routine.steps.length + 1) + (dropping ? 96 : 0);
  if (routine.steps.length > 0 || dropping) {
    nodes.push(card("end", (CARD_W - 120) / 2, endY, { kind: "end", title: firing ? endLine(firing) : "Done for this firing" }, { h: 32, w: 120 }));
    edges.push(wire(prev, "end", undefined, { dash: dropping }));
  } else {
    nodes.push(card("ghost", 0, at(1), { kind: "ghost", sub: "Drag a recipe here" }, { h: 56 }));
    edges.push(wire("when", "ghost", undefined, { dash: true }));
  }

  if (loop) {
    const last = `step:${routine.steps.at(-1)?.id}`;
    edges.push({
      id: "loop",
      source: last,
      sourceHandle: "loop-out",
      target: "when",
      targetHandle: "loop-in",
      type: "loop",
      label: "its own work can fail too",
      style: { stroke: SEAL, strokeWidth: 1.5, strokeDasharray: "4 4" },
      markerEnd: { type: MarkerType.ArrowClosed, color: SEAL, width: 14, height: 14 },
    });
  }
  return { nodes, edges };
}

function card(id: string, x: number, y: number, data: CardData, o: { h?: number; w?: number; selected?: boolean } = {}): Node<CardData> {
  const w = o.w ?? CARD_W;
  const h = o.h ?? CARD_H;
  return {
    id,
    type: "card",
    position: { x, y },
    data,
    width: w,
    height: h,
    style: { width: w, height: h },
    selected: o.selected ?? false,
    draggable: data.kind === "do",
    selectable: data.kind !== "ghost" && data.kind !== "end",
  };
}

function wire(source: string, target: string, label?: string, o: { dash?: boolean } = {}): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: "default",
    ...(label ? { label, labelStyle: { fill: "#6B6B73", fontFamily: "var(--mono)", fontSize: 10.5 }, labelBgStyle: { fill: "#0C0C0E" }, labelBgPadding: [6, 2] as [number, number] } : {}),
    style: { stroke: LINE_2, strokeWidth: 1.5, ...(o.dash ? { strokeDasharray: "4 4" } : {}) },
    markerEnd: { type: MarkerType.ArrowClosed, color: LINE_2, width: 14, height: 14 },
  };
}

/** What a recipe did in a firing, written onto its card. */
function overlay(did: RoutineFiring["steps"][number] | undefined, afterStop: boolean): Partial<CardData> {
  if (!did) return { sub: afterStop ? "Did not run: the routine stopped before it" : "Did not run", muted: true, pip: undefined };
  if (did.error) return { sub: `Could not start: ${did.error}`, yours: true, pip: "stopped" };
  if (did.nothingNeeded) return { sub: `Nothing to do: ${lowerFirst(did.nothingNeeded)}`, muted: true, pip: undefined };
  const started = `Started “${did.featureTitle ?? did.recipeName}”${did.costUsd !== null ? ` · ${money(did.costUsd)}` : ""}`;
  return did.yours ? { sub: started, yours: true, pip: did.now ?? "at your seal" } : { sub: `${started}${did.now ? ` · ${did.now}` : ""}`, muted: true, pip: undefined };
}

function firedLine(f: RoutineFiring): string {
  const how = f.triggeredBy === "schedule" ? "on schedule" : f.triggeredBy === "event" ? "by an event" : "by hand";
  return f.status === "skipped" ? `Skipped: ${f.skipReason ?? "it did nothing"}` : `Fired at ${clock(f.startedAt)}, ${how}`;
}

function endLine(f: RoutineFiring): string {
  if (f.status === "skipped") return "Skipped";
  if (f.status === "running") return "Still running";
  return f.finishedAt ? `Done at ${clock(f.finishedAt)}` : "Done";
}

function triggerKind(t: WorkflowTrigger): string {
  return t.kind === "schedule" ? "On a schedule" : t.kind === "event" ? "Something happens" : "Only when you start it";
}

function cap(s: string): string {
  return s ? (s[0]?.toUpperCase() ?? "") + s.slice(1) : s;
}

// ── one card ──

function Card({ data, selected }: NodeProps<Node<CardData>>): ReactNode {
  const d = data;
  const cls = ["rnode", d.kind, selected ? "sel" : "", d.yours ? "yours" : "", d.muted ? "muted" : ""].join(" ");
  const icon = d.kind === "when" ? <Icon.clock /> : d.kind === "do" ? <Icon.list /> : null;
  return (
    <div className={cls}>
      {d.kind !== "when" && !d.first && <Handle type="target" position={Position.Top} isConnectable={false} />}
      {d.loopIn && <Handle id="loop-in" type="target" position={Position.Right} isConnectable={false} />}
      {d.lab && (
        <div className="lab">
          {icon}
          <span>{d.lab}</span>
          {d.pip && <span className="pip-seal">{d.pip}</span>}
        </div>
      )}
      {d.title && <div className="t">{d.title}</div>}
      {d.sub && <div className="s">{d.sub}</div>}
      {(d.kind === "when" || d.kind === "do") && <Handle type="source" position={Position.Bottom} isConnectable={false} />}
      {d.loopOut && <Handle id="loop-out" type="source" position={Position.Right} isConnectable={false} />}
    </div>
  );
}

const NODE_TYPES = { card: Card };

/**
 * The loop, drawn as a wide arc out to the right and back, so it reads as "back to the
 * start" and its label sits clear of the cards instead of behind them.
 */
function LoopEdge({ sourceX, sourceY, targetX, targetY, label, markerEnd, style }: EdgeProps): ReactNode {
  const bulge = 150;
  const path = `M${sourceX} ${sourceY} C${sourceX + bulge} ${sourceY} ${targetX + bulge} ${targetY} ${targetX} ${targetY}`;
  const x = Math.max(sourceX, targetX) + bulge * 0.75;
  const y = (sourceY + targetY) / 2;
  return (
    <>
      <BaseEdge path={path} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} />
      <EdgeLabelRenderer>
        <div className="wlabel seal" style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>
          {label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const EDGE_TYPES = { loop: LoopEdge };

// ── the place ──

const DRAG_TYPE = "application/x-signet-routine";
type Dragged = { kind: "recipe"; id: string } | { kind: "trigger"; trigger: WorkflowTrigger };
const PALETTE_TRIGGERS: Array<[string, () => ReactNode, WorkflowTrigger]> = [
  ["On a schedule", () => <Icon.clock />, { kind: "schedule", every: "day", atHour: 3, atMinute: 0, onWeekday: 1 }],
  ["When something happens", () => <Icon.transfer />, { kind: "event", event: "step_merged" }],
  ["Only when I start it", () => <Icon.play />, { kind: "manual" }],
];

export function RoutineCanvas(): ReactNode {
  return (
    <ReactFlowProvider>
      <CanvasPlace />
    </ReactFlowProvider>
  );
}

function CanvasPlace(): ReactNode {
  const qc = useQueryClient();
  const wf = useQuery({ queryKey: ["workflows"], queryFn: api.workflows });
  const recipes = useQuery({ queryKey: ["recipes"], queryFn: api.recipes });
  const all = wf.data ?? [];
  const [currentId, setCurrentId] = useState<string | null>(null);
  const current: Workflow | undefined = all.find((w) => w.id === currentId) ?? (currentId === "new" ? undefined : all[0]);
  const [draft, setDraft] = useState<RoutineShape>({ trigger: null, steps: [] });
  // Memoised: the board's cards are rebuilt from this, and a new object each render would
  // reset React Flow's copy of them on every render.
  const routine: RoutineShape = useMemo(() => (current ? { trigger: current.trigger, steps: current.steps } : draft), [current, draft]);

  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<"card" | "new-recipe">("card");
  const [dropping, setDropping] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const firings = useQuery({ queryKey: ["firings", current?.id], queryFn: () => api.firings(current?.id ?? ""), enabled: !!current, refetchInterval: 10000 });
  const firing = (firings.data ?? []).find((f) => f.id === viewing) ?? null;

  useEffect(() => {
    setSelected(null);
    setViewing(null);
  }, [current?.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "e" && viewing) setViewing(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  const invalidate = () => void qc.invalidateQueries();
  const save = useMutation({
    mutationFn: (patch: { trigger?: WorkflowTrigger; recipeIds?: string[]; maxDepth?: number }) => {
      if (!current) throw new Error("no routine");
      return api.saveWorkflow({
        id: current.id,
        name: current.name,
        trigger: patch.trigger ?? current.trigger,
        recipeIds: patch.recipeIds ?? current.steps.map((s) => s.recipeId),
        maxDepth: patch.maxDepth ?? current.maxDepth,
        enabled: current.enabled,
      });
    },
    onSuccess: invalidate,
  });
  const create = useMutation({
    mutationFn: (d: { trigger: WorkflowTrigger; recipeIds: string[]; name: string }) =>
      api.saveWorkflow({ name: d.name, trigger: d.trigger, recipeIds: d.recipeIds, maxDepth: 1, enabled: false }),
    onSuccess: (r) => {
      setDraft({ trigger: null, steps: [] });
      setCurrentId(r.id);
      invalidate();
    },
  });
  const enable = useMutation({ mutationFn: () => api.setWorkflowEnabled(current?.id ?? "", !current?.enabled), onSuccess: invalidate });
  const run = useMutation({ mutationFn: () => api.runWorkflow(current?.id ?? ""), onSuccess: invalidate });

  /** Changes the routine: saved at once when it exists, kept as a draft until it has a trigger and a recipe. */
  const change = (next: { trigger?: WorkflowTrigger; recipeIds?: string[] }) => {
    if (current) return save.mutate(next);
    const trigger = next.trigger ?? draft.trigger;
    const recipeIds = next.recipeIds ?? draft.steps.map((s) => s.recipeId);
    if (trigger && recipeIds.length > 0) {
      const first = (recipes.data ?? []).find((r) => r.id === recipeIds[0]);
      return create.mutate({ trigger, recipeIds, name: first?.name ?? "Routine" });
    }
    setDraft({ trigger, steps: recipeIds.map((id, i) => ({ id: `draft-${i}`, recipeId: id, recipeName: (recipes.data ?? []).find((r) => r.id === id)?.name ?? "Recipe" })) });
  };

  const graph = useMemo(
    () => routineGraph({ routine, recipes: recipes.data ?? [], selected, dropping, firing }),
    [routine, recipes.data, selected, dropping, firing],
  );
  const flow = useReactFlow();
  // React Flow moves a card while it is dragged, so it holds its own copy of the cards,
  // reset from the routine whenever the routine (or what is drawn over it) changes.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CardData>>(graph.nodes);
  useEffect(() => setNodes(graph.nodes), [graph, setNodes]);
  // A card more or fewer: fit the board to it again, so nothing falls off the edge.
  useEffect(() => {
    const t = setTimeout(() => void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 150 }), 30);
    return () => clearTimeout(t);
  }, [graph.nodes.length, current?.id, flow]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw || firing) return;
    const dragged = JSON.parse(raw) as Dragged; // signet-policy-allow: raw-json-parse -- our own drag payload, set a moment ago by this page
    if (dragged.kind === "trigger") return change({ trigger: dragged.trigger });
    // Dropped among the cards: it goes where its height puts it.
    const y = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }).y;
    const ids = routine.steps.map((s) => s.recipeId);
    const at = Math.max(0, Math.min(ids.length, Math.round(y / STEP - 0.5)));
    ids.splice(at, 0, dragged.id);
    change({ recipeIds: ids });
  };

  const onNodeDragStop = (_: unknown, node: Node) => {
    if (!node.id.startsWith("step:")) return;
    const order = routine.steps
      .map((s, i) => ({ s, y: `step:${s.id}` === node.id ? node.position.y : (i + 1) * STEP }))
      .sort((a, b) => a.y - b.y)
      .map((x) => x.s.recipeId);
    if (order.join() !== routine.steps.map((s) => s.recipeId).join()) change({ recipeIds: order });
    // Dropped where it already was in the order: back into line, since the order is the layout.
    else setNodes(graph.nodes);
  };

  const narrow = typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches;
  const usable = (recipes.data ?? []).filter((r) => r.placeholders.length === 0);
  const loop = routine.trigger?.kind === "event" && SELF_CAUSED.has(routine.trigger.event) && routine.steps.length > 0;
  const step = routine.steps.find((s) => `step:${s.id}` === selected);

  if (narrow) return null;
  return (
    <>
      <div className="rt-head">
        <div style={{ minWidth: 0 }}>
          <select className="rt-name" value={current?.id ?? "new"} onChange={(e) => setCurrentId(e.target.value)}>
            {all.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
            <option value="new">New routine…</option>
          </select>
          <div className="st">{current ? stateLine(current, firings.data?.[0]?.startedAt ?? null) : "A new routine: drag a trigger and a recipe onto the board. It is saved switched off."}</div>
        </div>
        {current && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-outline" disabled={run.isPending} onClick={() => run.mutate()}>
              Run it once now
            </button>
            <button type="button" className={`btn ${current.enabled ? "btn-outline" : "btn-primary"}`} disabled={enable.isPending} onClick={() => enable.mutate()}>
              {current.enabled ? "Switch off" : "Switch on"}
            </button>
          </div>
        )}
      </div>
      {run.data && !run.data.started && <div style={{ color: "var(--fg-3)", fontSize: 12 }}>{run.data.reason}</div>}
      {current && (firings.data ?? []).length > 0 && (
        <div className="firings">
          <span>Firings</span>
          {[...(firings.data ?? [])].reverse().map((f) => (
            <button
              key={f.id}
              type="button"
              title={`${firedWhen(f.startedAt)} · ${f.status}`}
              className={`${viewing === f.id ? "on" : ""} ${f.steps.some((s) => s.yours) ? "seal" : ""}`}
              onClick={() => setViewing(viewing === f.id ? null : f.id)}
            />
          ))}
          {firing && <span style={{ color: "var(--fg-1)" }}>{firedWhen(firing.startedAt)}</span>}
          {firing && (
            <span style={{ marginLeft: "auto" }}>
              Editing <span className="kbd">E</span>
            </span>
          )}
        </div>
      )}
      <div className={`rt-body ${firing ? "wide" : ""}`}>
        {!firing && (
          <div className="palette">
            <div className="k" style={{ marginTop: 0 }}>
              When
            </div>
            {PALETTE_TRIGGERS.map(([label, icon, trigger]) => (
              <div key={label} className="pitem" draggable onDragStart={(e) => startDrag(e, { kind: "trigger", trigger })} onDragEnd={() => setDropping(false)}>
                {icon()}
                <span>{label}</span>
              </div>
            ))}
            <div className="k">Do · your recipes</div>
            {usable.map((r) => (
              <div key={r.id} className="pitem" draggable onDragStart={(e) => (startDrag(e, { kind: "recipe", id: r.id }), setDropping(true))} onDragEnd={() => setDropping(false)}>
                <Icon.list />
                <span>{r.name}</span>
              </div>
            ))}
            <button type="button" className="pitem add" onClick={() => (setPanel("new-recipe"), setSelected(null))}>
              <Icon.plus />
              <span>New recipe</span>
            </button>
            <div style={{ marginTop: "auto", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}>Drag onto the board. Every recipe’s work stops at your seal.</div>
          </div>
        )}
        <div className="rboard" onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = "copy"))} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            onNodesChange={onNodesChange}
            edges={graph.edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodeClick={(_, n) => (setPanel("card"), setSelected(n.id === "when" || n.id.startsWith("step:") ? n.id : null))}
            onPaneClick={() => setSelected(null)}
            onNodeDragStop={onNodeDragStop}
            nodesDraggable={!firing}
            nodesConnectable={false}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            minZoom={0.5}
            maxZoom={1.25}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color={LINE_1} />
          </ReactFlow>
          {loop && !firing && current && <LoopWarning routine={current} onChangeTrigger={() => setSelected("when")} onLimit={(n) => save.mutate({ maxDepth: n })} />}
        </div>
        <div className="side2">
          {firing ? (
            <FiringFacts f={firing} />
          ) : panel === "new-recipe" ? (
            <NewRecipe onDone={() => (setPanel("card"), invalidate())} />
          ) : selected === "when" && routine.trigger ? (
            <TriggerFacts t={routine.trigger} maxDepth={current?.maxDepth ?? 1} onPick={(t) => change({ trigger: t })} />
          ) : step ? (
            <StepFacts
              recipe={(recipes.data ?? []).find((r) => r.id === step.recipeId)}
              name={step.recipeName}
              onlyOne={routine.steps.length === 1}
              onRemove={() => {
                setSelected(null);
                change({ recipeIds: routine.steps.filter((s) => s.id !== step.id).map((s) => s.recipeId) });
              }}
            />
          ) : (
            <div className="facts2">
              <span className="k">The board</span>
              <span style={{ color: "var(--fg-2)", lineHeight: 1.55 }}>Click a card to see it here. Drag a card to reorder; drag from the left to add.</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function startDrag(e: DragEvent, d: Dragged): void {
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(d));
  e.dataTransfer.effectAllowed = "copy";
}

/** "Switched on · every night at 3:00 · last fired today, 3:00 am". A run by hand counts as a firing too. */
function stateLine(w: Workflow, lastFiring: string | null): string {
  const [prefix, slot] = triggerWords(w.trigger);
  const when = w.trigger.kind === "schedule" ? `${lowerFirst(prefix)} ${slot}` : w.trigger.kind === "event" ? `fires when ${slot}` : "fires when you start it";
  return [w.enabled ? "Switched on" : "Switched off", when, (lastFiring ?? w.lastFiredAt) ? `last fired ${lowerFirst(firedWhen(lastFiring ?? w.lastFiredAt ?? ""))}` : "never fired"].join(" · ");
}

function firedWhen(iso: string): string {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days === 0 ? "Today" : days === 1 ? "Last night" : new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
  return `${day}, ${clock(iso)}`;
}

// ── the right-hand side ──

function StepFacts({ recipe, name, onlyOne, onRemove }: { recipe: Recipe | undefined; name: string; onlyOne: boolean; onRemove: () => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const estimate = useQuery({ queryKey: ["estimate", recipe?.repoPath ?? null], queryFn: () => api.estimate(recipe?.repoPath ?? undefined) });
  return (
    <>
      <div className="facts2">
        <span className="k">Recipe</span>
        <b style={{ fontWeight: 500 }}>{name}</b>
        <span className={open ? "" : "clamp3"} style={{ color: "var(--fg-2)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
          {recipe?.goalMd ?? ""}
        </span>
        {open && <span className="mono" style={{ color: "var(--fg-3)" }}>{recipe?.repoLabel ?? "the configured repo"}</span>}
      </div>
      <div className="facts2">
        <span className="k">Each firing</span>
        <span style={{ color: "var(--fg-2)", lineHeight: 1.55 }}>Proposes a plan, initials it for you, and builds its first step. The rest of the plan waits for you.</span>
      </div>
      {estimate.data?.usd !== null && estimate.data?.usd !== undefined && (
        <div className="facts2">
          <span className="k">Likely cost</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            About {money(estimate.data.usd)} a firing, from the last {estimate.data.sample}
          </span>
        </div>
      )}
      <div className="facts2">
        <span className="k">If it cannot start</span>
        <span style={{ color: "var(--fg-2)", lineHeight: 1.55 }}>The routine stops here, and it shows on your Desk.</span>
      </div>
      <div className="btnrow">
        <button type="button" className="btn btn-outline" onClick={() => setOpen(!open)}>
          {open ? "Close recipe" : "Open recipe"}
        </button>
        <button type="button" className="btn btn-outline" disabled={onlyOne} title={onlyOne ? "A routine needs at least one recipe." : undefined} onClick={onRemove}>
          Remove
        </button>
      </div>
    </>
  );
}

const SCHEDULES: Array<[string, WorkflowTrigger]> = [
  ...[0, 3, 6, 9, 12, 15, 18, 21].map((h): [string, WorkflowTrigger] => [`day at ${hm(h, 0)}`, { kind: "schedule", every: "day", atHour: h, atMinute: 0, onWeekday: 1 }]),
  ["every hour", { kind: "schedule", every: "hour", atHour: 0, atMinute: 0, onWeekday: 1 }],
  ["Monday at 9:00", { kind: "schedule", every: "week", atHour: 9, atMinute: 0, onWeekday: 1 }],
];

function TriggerFacts({ t, maxDepth, onPick }: { t: WorkflowTrigger; maxDepth: number; onPick: (t: WorkflowTrigger) => void }): ReactNode {
  const [, slot] = triggerWords(t);
  const same = (a: WorkflowTrigger, b: WorkflowTrigger) => JSON.stringify(a) === JSON.stringify(b);
  return (
    <>
      <div className="facts2">
        <span className="k">When</span>
        <b style={{ fontWeight: 500 }}>{cap(t.kind === "schedule" ? triggerWords(t).join(" ") : slot)}</b>
      </div>
      <div className="facts2">
        <span className="k">{triggerKind(t)}</span>
        <div className="chips">
          {t.kind === "schedule" &&
            SCHEDULES.map(([label, s]) => (
              <button key={label} type="button" className={`chip ${same(s, t) ? "on" : ""}`} onClick={() => onPick(s)}>
                {label}
              </button>
            ))}
          {t.kind === "event" &&
            Object.entries(EVENT_WORDS).map(([e, words]) => (
              <button key={e} type="button" className={`chip ${t.event === e ? "on" : ""}`} onClick={() => onPick({ kind: "event", event: e as never })}>
                {cap(words)}
              </button>
            ))}
          {t.kind === "manual" && <span style={{ color: "var(--fg-2)" }}>It fires only when you press “Run it once now”.</span>}
        </div>
      </div>
      {t.kind === "event" && (
        <div className="facts2">
          <span className="k">Chain limit</span>
          <span style={{ color: "var(--fg-2)", lineHeight: 1.55 }}>
            {maxDepth === 0 ? "It never fires itself again." : `${maxDepth} more ${maxDepth === 1 ? "firing" : "firings"} at most. Then it stops, and says why.`}
          </span>
        </div>
      )}
      <div className="facts2">
        <span className="k">Change the kind</span>
        <div className="chips">
          {PALETTE_TRIGGERS.map(([label, , trig]) => (
            <button key={label} type="button" className={`chip ${trig.kind === t.kind ? "on" : ""}`} onClick={() => trig.kind !== t.kind && onPick(trig)}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function LoopWarning({ routine, onChangeTrigger, onLimit }: { routine: Workflow; onChangeTrigger: () => void; onLimit: (n: number) => void }): ReactNode {
  const key = `signet.loop-kept.${routine.id}`;
  const [kept, setKept] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const [limit, setLimit] = useState(Math.min(routine.maxDepth, 3));
  const event = routine.trigger.kind === "event" ? EVENT_WORDS[routine.trigger.event] : "";
  if (kept) {
    return (
      <div className="loopnote">
        <span className="dot-seal" />
        It can start itself · {routine.maxDepth === 0 ? "it never fires itself again" : `at most ${routine.maxDepth} more ${routine.maxDepth === 1 ? "firing" : "firings"} from one cause`}
        <button type="button" onClick={() => setKept(false)}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div className="now yours loopwarn">
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <span className="dot-seal" />
        <b>This routine can start itself</b>
      </div>
      <div style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.6 }}>
        The work it starts can {routine.trigger.kind === "event" && routine.trigger.event === "quota_reset" ? "use up your quota, and" : "fail, and"} “when {event}” fires it again. One cause may set off at most this many more firings before it stops and says so:
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="chips">
          {[0, 1, 2, 3].map((n) => (
            <button key={n} type="button" className={`chip ${limit === n ? "on" : ""}`} onClick={() => setLimit(n)}>
              {n}
            </button>
          ))}
        </span>
        <button type="button" className="btn btn-outline" style={{ marginLeft: "auto" }} onClick={onChangeTrigger}>
          Change the trigger
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (limit !== routine.maxDepth) onLimit(limit);
            try {
              localStorage.setItem(key, "1");
            } catch {
              /* a remembered choice is a convenience; without it the warning shows again */
            }
            setKept(true);
          }}
        >
          Keep it, with this limit
        </button>
      </div>
    </div>
  );
}

/** Where the work stands, as the end of a sentence about it. */
function nowSentence(now: string | null): string {
  if (!now) return "is waiting for you";
  if (now.startsWith("asked")) return `has ${now}`;
  if (now === "failed") return "has failed";
  return `is ${now}`;
}

function FiringFacts({ f }: { f: RoutineFiring }): ReactNode {
  const took = f.finishedAt ? Math.max(1, Math.round((new Date(f.finishedAt).getTime() - new Date(f.startedAt).getTime()) / 60_000)) : null;
  const how = f.triggeredBy === "schedule" ? "Fired on schedule" : f.triggeredBy === "event" ? "Fired by an event" : "Started by hand";
  const waiting = f.steps.filter((s) => s.yours && !s.error);
  const nothing = f.steps.filter((s) => s.nothingNeeded);
  const stopped = f.steps.find((s) => s.error);
  return (
    <>
      <div className="facts2">
        <span className="k">{firedWhen(f.startedAt)}</span>
        <span style={{ color: "var(--fg-2)", lineHeight: 1.55, fontVariantNumeric: "tabular-nums" }}>
          {f.status === "skipped" ? `Skipped: ${f.skipReason ?? "it did nothing"}` : [how, took !== null ? `took ${took} ${took === 1 ? "minute" : "minutes"}` : "still running", f.costUsd !== null ? money(f.costUsd) : null].filter(Boolean).join(" · ")}
        </span>
      </div>
      {waiting.map((s) => (
        <div key={s.featureId ?? s.recipeName} className="facts2">
          <span className="k">Waiting for you</span>
          <span style={{ lineHeight: 1.55 }}>
            “{s.featureTitle ?? s.recipeName}” {nowSentence(s.now)}.
          </span>
          {s.featureId && s.incrementId && (
            <button
              type="button"
              className="btn btn-seal"
              style={{ alignSelf: "flex-start" }}
              onClick={() => navigate({ view: "thread", featureId: s.featureId ?? "", sheet: s.now === "at your seal" ? { kind: "seal", step: s.incrementId ?? "" } : undefined })}
            >
              {s.now === "at your seal" ? "Review and seal" : "Look"}
            </button>
          )}
        </div>
      ))}
      {stopped && (
        <div className="facts2">
          <span className="k">Stopped</span>
          <span style={{ lineHeight: 1.55 }}>
            {stopped.recipeName} could not start: {stopped.error}
          </span>
        </div>
      )}
      {nothing.map((s) => (
        <div key={s.recipeName} className="facts2">
          <span className="k">Nothing to do</span>
          <span style={{ color: "var(--fg-2)", lineHeight: 1.55 }}>
            {s.recipeName}: {lowerFirst(s.nothingNeeded ?? "")} That is the routine working, not failing.
          </span>
        </div>
      ))}
    </>
  );
}

function NewRecipe({ onDone }: { onDone: () => void }): ReactNode {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const create = useMutation({ mutationFn: () => api.createRecipe({ name: name.trim(), goalMd: goal.trim() }), onSuccess: onDone });
  const short = goal.trim().length < 20;
  return (
    <div className="facts2">
      <span className="k">New recipe</span>
      <input className="field-in" value={name} onChange={(e) => setName(e.target.value)} placeholder="A name, like “Tidy what lint flags”" />
      <textarea
        className="field-in"
        rows={5}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="What should it do, each time it runs? Write it as you would ask for it."
      />
      <div className="btnrow">
        <button type="button" className="btn btn-primary" disabled={!name.trim() || short || create.isPending} title={short ? "Say a little more: at least a sentence." : undefined} onClick={() => create.mutate()}>
          Save recipe
        </button>
        <button type="button" className="btn btn-outline" onClick={onDone}>
          Cancel
        </button>
      </div>
      {create.error && <span style={{ color: "var(--seal)", fontSize: 12 }}>{String(create.error.message)}</span>}
    </div>
  );
}
