// Workshop: tuning the machine — conventions, routines, health. Visited rarely, so it
// is one place with three tabs rather than three places.

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Recipe, RuleCard, Workflow, WorkflowRunView, WorkflowTrigger } from "@signet/contracts";
import { api } from "../api.js";
import { Shell } from "./shell.js";
import { navigate, type Route } from "./router.js";
import { clock } from "./format.js";
import { useDesk } from "./data.js";

export function Workshop({ route }: { route: Extract<Route, { view: "workshop" }> }): ReactNode {
  const tabs = [
    ["conventions", "Conventions"],
    ["routines", "Routines"],
    ["health", "Health"],
  ] as const;
  return (
    <Shell place="workshop" title="Workshop">
      <div className="subnav" style={{ margin: 0, padding: 0, border: 0 }}>
        {tabs.map(([k, label]) => (
          <button key={k} type="button" className={`tab ${route.tab === k ? "on" : ""}`} onClick={() => navigate({ view: "workshop", tab: k })}>
            {label}
          </button>
        ))}
      </div>
      {route.tab === "conventions" && <Conventions />}
      {route.tab === "routines" && <Routines />}
      {route.tab === "health" && <Health />}
    </Shell>
  );
}

// ── conventions ──

/** "14 of 14 modules", "41 uses · 3 exceptions" — the evidence, counted. */
export function evidenceText(r: RuleCard): string {
  const n = r.evidence.length;
  const ex = r.exceptions?.length ?? 0;
  return `${n} ${n === 1 ? "use" : "uses"}${ex > 0 ? ` · ${ex} ${ex === 1 ? "exception" : "exceptions"}` : ""}`;
}

function why(r: RuleCard): string {
  const detail = r.evidence.find((e) => e.detail)?.detail;
  const where = r.evidence.slice(0, 2).map((e) => e.ref).join(", ");
  return [detail, where ? `Seen in ${where}${r.evidence.length > 2 ? ` and ${r.evidence.length - 2} more` : ""}.` : null].filter(Boolean).join(" · ");
}

function Conventions(): ReactNode {
  const qc = useQueryClient();
  // This repo's conventions only: patterns learned from other repositories are theirs.
  const repo = useDesk().data?.repoLabel;
  const q = useQuery({ queryKey: ["rules", repo], queryFn: () => api.ruleQueue(repo), enabled: repo !== undefined });
  const act = useMutation({
    mutationFn: async (a: { ids: string[]; accept: boolean }) => {
      for (const id of a.ids) await (a.accept ? api.confirmRule(id) : api.rejectRule(id));
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["rules"] }),
  });
  const rules = [...(q.data ?? [])].sort((a, b) => b.confidence - a.confidence);
  const clean = rules.filter((r) => (r.exceptions?.length ?? 0) === 0);
  return (
    <>
      <div style={{ fontSize: 14, color: "var(--fg-2)", maxWidth: "70ch", lineHeight: 1.6 }}>
        Patterns Signet read out of your code. None is enforced until you accept it, and accepted ones only warn.
      </div>
      {rules.length === 0 ? (
        <div className="quiet">
          <div className="big">Nothing to decide.</div>
          <div>Every pattern Signet read out of your code has been accepted or set aside.</div>
        </div>
      ) : (
        <>
          <div className="inbox" style={{ flex: "0 1 auto", minHeight: 0, overflow: "auto" }}>
            {rules.map((r) => (
              <div key={r.id} className="dec" style={{ gridTemplateColumns: "minmax(0,1fr) 160px auto", cursor: "default" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="what">{r.statement}</div>
                  <div className="why">{why(r)}</div>
                </div>
                <div>
                  <div className="meta" style={{ margin: "0 0 4px" }}>
                    {evidenceText(r)}
                  </div>
                  <div className="meter" style={{ width: "100%" }}>
                    <i style={{ width: `${Math.round(r.confidence * 100)}%` }} />
                  </div>
                </div>
                <div className="acts">
                  <button type="button" className="btn btn-outline" disabled={act.isPending} onClick={() => act.mutate({ ids: [r.id], accept: true })}>
                    Accept
                  </button>
                  <button type="button" className="btn btn-outline" disabled={act.isPending} onClick={() => act.mutate({ ids: [r.id], accept: false })}>
                    Not this
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {clean.length > 0 && (
              <button type="button" className="btn btn-secondary" disabled={act.isPending} onClick={() => act.mutate({ ids: clean.map((r) => r.id), accept: true })}>
                Accept the {clean.length} with no exceptions
              </button>
            )}
            <span style={{ color: "var(--fg-3)", fontSize: 12 }}>Strongest evidence first</span>
          </div>
        </>
      )}
    </>
  );
}

// ── routines, as sentences ──

const EVENT_WORDS: Record<string, string> = {
  step_merged: "a step lands",
  run_failed: "a run fails",
  rules_proposed: "new conventions are found",
  quota_reset: "the Claude quota comes back",
};

function hm(h: number, m: number): string {
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** The trigger, as the opening of a sentence: [prefix, slot]. */
export function triggerWords(t: WorkflowTrigger): [string, string] {
  switch (t.kind) {
    case "schedule": {
      if (t.every === "hour") return ["Every", "hour"];
      const part = t.atHour < 6 || t.atHour >= 21 ? "night" : t.atHour < 12 ? "morning" : t.atHour < 18 ? "afternoon" : "evening";
      if (t.every === "day") return ["Every", `${part} at ${hm(t.atHour, t.atMinute)}`];
      const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][t.onWeekday] ?? "Monday";
      return ["Every", `${day} at ${hm(t.atHour, t.atMinute)}`];
    }
    case "event":
      return ["When", EVENT_WORDS[t.event] ?? t.event];
    case "manual":
      return ["When", "I say so"];
  }
}

function lowerFirst(s: string): string {
  return s ? (s[0]?.toLowerCase() ?? "") + s.slice(1) : s;
}

function Routines(): ReactNode {
  const qc = useQueryClient();
  const wf = useQuery({ queryKey: ["workflows"], queryFn: api.workflows });
  const recipes = useQuery({ queryKey: ["recipes"], queryFn: api.recipes });
  const runs = useQuery({ queryKey: ["workflow-runs"], queryFn: api.workflowRuns, refetchInterval: 10000 });
  const invalidate = () => void qc.invalidateQueries();
  return (
    <div className="routines" style={{ display: "flex", flexDirection: "column", gap: 16, overflow: "auto", flex: 1, minHeight: 0 }}>
      {(wf.data ?? []).map((w) => (
        <RoutineCard key={w.id} w={w} recipes={recipes.data ?? []} runs={(runs.data ?? []).filter((r) => r.workflowId === w.id)} onChange={invalidate} />
      ))}
      <NewRoutine recipes={recipes.data ?? []} onSaved={invalidate} />
    </div>
  );
}

/** A slot you can change: shows as the word, becomes a picker when clicked. */
function Slot({ value, stop = false, children }: { value: string; stop?: boolean; children?: (close: () => void) => ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  if (open && children) return <span className="slot">{children(() => setOpen(false))}</span>;
  return (
    <button type="button" className={`slot ${stop ? "stop" : ""}`} onClick={() => children && setOpen(true)} style={{ cursor: children ? "pointer" : "default", font: "inherit" }}>
      {value}
    </button>
  );
}

function TriggerPicker({ t, onPick }: { t: WorkflowTrigger; onPick: (t: WorkflowTrigger) => void }): ReactNode {
  const value = t.kind === "schedule" ? `${t.every}@${t.atHour}` : t.kind === "event" ? `event:${t.event}` : "manual";
  const options: Array<[string, string, WorkflowTrigger]> = [
    ...[0, 3, 6, 9, 12, 15, 18, 21].map((h): [string, string, WorkflowTrigger] => [`day@${h}`, `day at ${hm(h, 0)}`, { kind: "schedule", every: "day", atHour: h, atMinute: 0, onWeekday: 1 }]),
    ["hour@0", "hour", { kind: "schedule", every: "hour", atHour: 0, atMinute: 0, onWeekday: 1 }],
    ["week@9", "Monday at 9:00", { kind: "schedule", every: "week", atHour: 9, atMinute: 0, onWeekday: 1 }],
    ...Object.entries(EVENT_WORDS).map(([e, w]): [string, string, WorkflowTrigger] => [`event:${e}`, `when ${w}`, { kind: "event", event: e as never }]),
    ["manual", "when I say so", { kind: "manual" }],
  ];
  return (
    <select
      autoFocus
      value={options.some((o) => o[0] === value) ? value : ""}
      onChange={(e) => {
        const o = options.find((x) => x[0] === e.target.value);
        if (o) onPick(o[2]);
      }}
      style={{ background: "transparent", color: "var(--fg-1)", border: 0, font: "inherit" }}
    >
      <option value="">choose when…</option>
      {options.map(([k, label]) => (
        <option key={k} value={k}>
          {label}
        </option>
      ))}
    </select>
  );
}

function RecipePicker({ recipes, value, onPick }: { recipes: Recipe[]; value: string; onPick: (id: string) => void }): ReactNode {
  return (
    <select autoFocus value={value} onChange={(e) => onPick(e.target.value)} style={{ background: "transparent", color: "var(--fg-1)", border: 0, font: "inherit" }}>
      <option value="">choose what…</option>
      {recipes.filter((r) => r.placeholders.length === 0).map((r) => (
        <option key={r.id} value={r.id}>
          {lowerFirst(r.name)}
        </option>
      ))}
    </select>
  );
}

function RoutineCard({ w, recipes, runs, onChange }: { w: Workflow; recipes: Recipe[]; runs: WorkflowRunView[]; onChange: () => void }): ReactNode {
  const save = useMutation({
    mutationFn: (patch: { trigger?: WorkflowTrigger; recipeIds?: string[] }) =>
      api.saveWorkflow({
        id: w.id,
        name: w.name,
        trigger: patch.trigger ?? w.trigger,
        recipeIds: patch.recipeIds ?? w.steps.map((s) => s.recipeId),
        maxDepth: w.maxDepth,
        enabled: w.enabled,
      }),
    onSuccess: onChange,
  });
  const enable = useMutation({ mutationFn: () => api.setWorkflowEnabled(w.id, !w.enabled), onSuccess: onChange });
  const run = useMutation({ mutationFn: () => api.runWorkflow(w.id), onSuccess: onChange });
  const [prefix, when] = triggerWords(w.trigger);
  const first = recipes.find((r) => r.id === w.steps[0]?.recipeId);
  return (
    <>
      <div className="inbox" style={{ padding: "24px 28px" }}>
        <div className="sentence">
          {prefix}{" "}
          <Slot value={when}>{(close) => <TriggerPicker t={w.trigger} onPick={(t) => (save.mutate({ trigger: t }), close())} />}</Slot>,{" "}
          <Slot value={lowerFirst(w.steps.map((s) => s.recipeName).join(", then ") || "choose what")}>
            {(close) => <RecipePicker recipes={recipes} value={w.steps[0]?.recipeId ?? ""} onPick={(id) => (id && save.mutate({ recipeIds: [id] }), close())} />}
          </Slot>{" "}
          in <Slot value={first?.repoLabel ?? "the configured repo"} />, build <Slot value="the first step" />, then <Slot value="wait for my seal" stop />.
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line-1)" }}>
          <button type="button" className={`btn ${w.enabled ? "btn-outline" : "btn-primary"}`} disabled={enable.isPending} onClick={() => enable.mutate()}>
            {w.enabled ? "Switch off" : "Switch on"}
          </button>
          <button type="button" className="btn btn-outline" disabled={run.isPending} onClick={() => run.mutate()}>
            Run it once now
          </button>
          <span style={{ color: "var(--fg-3)", fontSize: 12, marginLeft: "auto" }}>
            {run.data && !run.data.started
              ? run.data.reason
              : w.enabled
                ? w.lastFiredAt
                  ? `Switched on · last ran ${clock(w.lastFiredAt)}`
                  : "Switched on"
                : "Saved switched off · a routine nobody armed never fires"}
          </span>
        </div>
      </div>
      {runs.length > 0 && (
        <div className="inbox">
          {runs.slice(0, 5).map((r) => (
            <div key={r.id} className="dec" style={{ gridTemplateColumns: "20px minmax(0,1fr) auto", cursor: "default" }}>
              <span className="dot-grey" />
              <div>
                <div className="what">{runWhen(r.startedAt)}</div>
                <div className="why">{runSentence(r)}</div>
              </div>
              <span className="crumb">{r.status === "skipped" ? "no cost beyond the read" : ""}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function runWhen(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days === 0 ? "Today" : days === 1 ? "Last night" : days === 2 ? "Two nights ago" : d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
  return `${day}, ${clock(d)}`;
}

function runSentence(r: WorkflowRunView): string {
  if (r.status === "skipped") return r.skipReason ?? "It did nothing.";
  const o = r.outcomes[0];
  if (!o) return r.status === "running" ? "Running now." : "It ran.";
  if (o.nothingNeeded) return `Nothing needed doing — ${lowerFirst(o.nothingNeeded)}`;
  if (o.error) return `It could not: ${o.error}`;
  return `Proposed and built “${o.recipeName}”. It is at your seal.`;
}

/** A new routine is a blank sentence: fill its slots and save. */
function NewRoutine({ recipes, onSaved }: { recipes: Recipe[]; onSaved: () => void }): ReactNode {
  const [trigger, setTrigger] = useState<WorkflowTrigger | null>(null);
  const [recipeId, setRecipeId] = useState("");
  const recipe = recipes.find((r) => r.id === recipeId);
  const save = useMutation({
    mutationFn: () =>
      api.saveWorkflow({ name: recipe?.name ?? "Routine", trigger: trigger as WorkflowTrigger, recipeIds: [recipeId], maxDepth: 1, enabled: false }),
    onSuccess: () => {
      setTrigger(null);
      setRecipeId("");
      onSaved();
    },
  });
  const [prefix, when] = trigger ? triggerWords(trigger) : ["Every", "choose when"];
  return (
    <div className="inbox" style={{ padding: "24px 28px", opacity: trigger && recipeId ? 1 : 0.7 }}>
      <div className="sentence">
        {prefix} <Slot value={when}>{(close) => <TriggerPicker t={trigger ?? { kind: "manual" }} onPick={(t) => (setTrigger(t), close())} />}</Slot>,{" "}
        <Slot value={recipe ? lowerFirst(recipe.name) : "choose what"}>{(close) => <RecipePicker recipes={recipes} value={recipeId} onPick={(id) => (setRecipeId(id), close())} />}</Slot> in{" "}
        <Slot value={recipe?.repoLabel ?? "the repo"} />, build <Slot value="the first step" />, then <Slot value="wait for my seal" stop />.
      </div>
      {trigger && recipeId && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line-1)" }}>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            Save it
          </button>
          <span style={{ color: "var(--fg-3)", fontSize: 12, marginLeft: "auto" }}>Saved switched off · a routine nobody armed never fires</span>
        </div>
      )}
    </div>
  );
}

// ── health ──

function Health(): ReactNode {
  const q = useQuery({ queryKey: ["health-lines"], queryFn: api.healthLines, refetchInterval: 15000 });
  const lines = q.data?.lines ?? [];
  const bad = lines.find((l) => !l.ok && l.problem);
  return (
    <>
      {bad?.problem && (
        <div className="now yours" style={{ marginTop: 0 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span className="dot-seal" />
            <b>{bad.problem.title}</b>
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.6 }}>{bad.problem.explain}</div>
          {bad.problem.command && (
            <div style={{ display: "flex", gap: 8 }}>
              <span className="path">{bad.problem.command}</span>
              <button type="button" className="btn btn-outline" onClick={() => void navigator.clipboard?.writeText(bad.problem?.command ?? "").catch(() => {})}>
                Copy
              </button>
            </div>
          )}
        </div>
      )}
      <div className="inbox">
        {lines.map((l) => (
          <div key={l.label} className="dec" style={{ gridTemplateColumns: "20px 200px minmax(0,1fr)", cursor: "default" }}>
            <span className={l.ok ? "dot-grey" : "dot-seal"} />
            <div className="what" style={{ fontSize: 14 }}>
              {l.label}
            </div>
            <div className="why" style={{ margin: 0, ...(l.ok ? {} : { color: "var(--seal)" }) }}>
              {l.value}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

