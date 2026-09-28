// The command bar: everything, one key away, with what is waiting on you first. Enter on
// a seal opens its sheet — the bar gets you to a decision fast, never past its proof.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { Icon } from "./icons.js";
import { navigate, type Route } from "./router.js";
import { useDesk } from "./data.js";

interface Item {
  group: "Waiting for you" | "Do" | "Go to";
  icon: ReactNode;
  label: string;
  kbd?: string;
  /** Other words it answers to when searched. */
  also?: string;
  run: () => void;
}

export function CommandBar({ onClose }: { onClose: () => void }): ReactNode {
  const qc = useQueryClient();
  const desk = useDesk();
  const features = useQuery({ queryKey: ["features"], queryFn: api.features });
  const dispatcher = useQuery({ queryKey: ["dispatcher"], queryFn: api.dispatcher });
  const automation = useQuery({ queryKey: ["automation"], queryFn: api.automationState });
  const hold = useMutation({ mutationFn: (paused: boolean) => api.setDispatcher({ paused }), onSuccess: () => void qc.invalidateQueries() });
  const routines = useMutation({ mutationFn: (paused: boolean) => api.setAutomationPaused(paused), onSuccess: () => void qc.invalidateQueries() });
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  const go = (r: Route) => () => {
    onClose();
    navigate(r);
  };

  const items = useMemo<Item[]>(() => {
    const decisions = desk.data?.decisions ?? [];
    const seals = decisions.filter((d) => d.kind === "seal");
    const waiting: Item[] = decisions.map((d) => ({
      group: "Waiting for you",
      icon: d.kind === "seal" ? <Icon.lock /> : <Icon.pen />,
      label: d.kind === "seal" ? `Seal “${d.stepTitle}”` : d.kind === "initial" ? `Initial the plan · “${d.stepTitle}”` : d.kind === "question" ? `Answer · “${d.stepTitle}”` : `Look at · “${d.stepTitle}”`,
      run: go(
        d.kind === "seal" || d.kind === "initial"
          ? { view: "thread", featureId: d.featureId, sheet: { kind: d.kind, step: d.incrementId } }
          : { view: "thread", featureId: d.featureId },
      ),
    }));
    if (seals.length > 1 && seals[0]) {
      const first = seals[0];
      waiting.splice(1, 0, {
        group: "Waiting for you",
        icon: <Icon.lock />,
        label: `Go through everything waiting · ${seals.length}`,
        also: "seal",
        run: go({ view: "thread", featureId: first.featureId, sheet: { kind: "seal", step: first.incrementId } }),
      });
    }
    const paused = dispatcher.data?.paused ?? false;
    const autoPaused = automation.data?.paused ?? false;
    const doing: Item[] = [
      { group: "Do", icon: <Icon.plus />, label: "Ask for something new", kbd: "N", run: go({ view: "ask" }) },
      { group: "Do", icon: <Icon.pause />, label: paused ? "Let everything build again" : "Hold everything", run: () => (hold.mutate(!paused), onClose()) },
      { group: "Do", icon: <Icon.wrench />, label: autoPaused ? "Resume routines" : "Pause routines", run: () => (routines.mutate(!autoPaused), onClose()) },
    ];
    const going: Item[] = [
      { group: "Go to", icon: <Icon.undo />, label: "Ledger · take something back", run: go({ view: "flow", tab: "ledger" }) },
      ...(features.data ?? []).map((f) => ({
        group: "Go to" as const,
        icon: <Icon.git />,
        label: `${f.title} · thread`,
        run: go({ view: "thread", featureId: f.id }),
      })),
      { group: "Go to", icon: <Icon.wrench />, label: "Workshop · routines", run: go({ view: "workshop", tab: "routines" }) },
      { group: "Go to", icon: <Icon.wrench />, label: "Workshop · health", run: go({ view: "workshop", tab: "health" }) },
      { group: "Go to", icon: <Icon.folder />, label: "Point Signet at another repo", run: go({ view: "welcome" }) },
    ];
    return [...waiting, ...doing, ...going];
  }, [desk.data, features.data, dispatcher.data, automation.data]);

  const needle = q.trim().toLowerCase();
  const shown = items.filter((i) => `${i.label} ${i.also ?? ""}`.toLowerCase().includes(needle)).slice(0, 12);
  useEffect(() => setSel(0), [q]);

  let lastGroup: string | null = null;
  return (
    <div className="sheet-wrap" style={{ justifyContent: "center", background: "var(--overlay)" }} onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command bar">
        <input
          className="q"
          autoFocus
          value={q}
          placeholder="Type a command, a feature, or seal"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") setSel((s) => Math.min(shown.length - 1, s + 1));
            else if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
            else if (e.key === "Enter") shown[sel]?.run();
            else return;
            e.preventDefault();
          }}
          style={{ width: "100%", background: "transparent", border: 0, borderBottom: "1px solid var(--line-1)", color: "var(--fg-1)", font: "inherit", fontSize: 16, outline: "none", display: "block" }}
        />
        {shown.map((it, i) => {
          const head = it.group !== lastGroup ? <div className="grp">{it.group}</div> : null;
          lastGroup = it.group;
          return (
            <div key={`${it.group}-${it.label}`}>
              {head}
              <button type="button" className={`it ${i === sel ? "on" : ""}`} onMouseEnter={() => setSel(i)} onClick={it.run}>
                {it.icon}
                <span>{it.label}</span>
                {(i === sel || it.kbd) && <span className="kbd">{i === sel ? "↵" : it.kbd}</span>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
