// Watching the agent work: what it is trying to do now, in a sentence; its own plan of
// attack, ticking off; the last few things it did, with the reason attached; and where in
// the repo it has been, with the fence drawn round what it may change.

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentAction, AgentTodo } from "@signet/contracts";
import { api } from "../api.js";
import { Shell } from "./shell.js";
import { navigate, type Route } from "./router.js";
import { clockSeconds, elapsed, money } from "./format.js";
import { Tick } from "./icons.js";
import { RepoMap } from "./repomap.js";

export function headline(todos: readonly AgentTodo[], actions: readonly AgentAction[]): string | null {
  const now = todos.find((t) => t.status === "in_progress");
  if (now) return now.activeForm ?? now.content;
  const last = actions.at(-1);
  return last ? say(last) : null;
}

export function say(a: AgentAction): string {
  switch (a.kind) {
    case "read":
      return `Reading ${a.path}`;
    case "edit":
      return `Editing ${a.path}`;
    case "search":
      return `Searching for ${a.text}`;
    case "command":
      return a.why ?? `Running ${a.text}`;
    default:
      return a.text ?? "Working";
  }
}

function tapeLine(a: AgentAction): ReactNode {
  switch (a.kind) {
    case "read":
      return (
        <>
          read <b>{a.path}</b>
        </>
      );
    case "edit":
      return (
        <>
          editing <b>{a.path}</b>
        </>
      );
    case "search":
      return (
        <>
          searched for <b>{a.text}</b>
        </>
      );
    case "command":
      return (
        <>
          {a.why ? (
            <>
              <b>{a.why}</b>
            </>
          ) : (
            <>
              ran <b>{(a.text ?? "").length > 80 ? `${(a.text ?? "").slice(0, 80)}…` : a.text}</b>
            </>
          )}
        </>
      );
    default:
      return <>{a.text}</>;
  }
}

export function Watch({ route }: { route: Extract<Route, { view: "watch" }> }): ReactNode {
  const t = useQuery({ queryKey: ["thread", route.featureId], queryFn: () => api.thread(route.featureId), refetchInterval: 4000 });
  const step = t.data?.steps.find((s) => s.id === route.step);
  const runId = step?.runId ?? null;
  const w = useQuery({ queryKey: ["work", runId], queryFn: () => api.runWork(runId as string), enabled: runId !== null, refetchInterval: 3000 });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  const live = t.data?.now?.incrementId === route.step ? t.data.now : null;
  const todos = w.data?.todos ?? [];
  const actions = w.data?.actions ?? [];
  const current = todos.find((x) => x.status === "in_progress");
  const currentSince = [...actions].reverse().find((a) => a.kind !== "todos")?.at;

  return (
    <Shell place="flow" title={t.data?.title ?? ""} crumb="Flow" onCrumb={() => navigate({ view: "flow", tab: "motion" })}>
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "minmax(0,1fr) 420px", gap: 24, overflow: "hidden" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20, overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--fg-3)", fontSize: 12 }}>
            {live ? <span className="pulse" /> : <span className="dot-grey" />}
            Step {t.data?.steps.findIndex((s) => s.id === route.step) !== undefined ? (t.data?.steps.findIndex((s) => s.id === route.step) ?? 0) + 1 : ""} · {step?.title}
            {live && ` · ${elapsed(live.phaseEnteredAt, now)} · ${money(live.spentUsd)}`}
            {!live && step && ` · ${step.said}`}
          </div>
          <div className="intent">{headline(todos, actions) ?? "It has not started working yet."}</div>
          {todos.length > 0 && (
            <div className="attack">
              {todos.map((x, i) =>
                x.status === "completed" ? (
                  <div key={i} className="d">
                    <Tick />
                    <span>{x.content}</span>
                    <span />
                  </div>
                ) : x.status === "in_progress" ? (
                  <div key={i} className="c">
                    <span className="o" />
                    <span>{x.content}</span>
                    <span className="crumb">now{currentSince && x === current ? ` · ${elapsed(currentSince, now)}` : ""}</span>
                  </div>
                ) : (
                  <div key={i}>
                    <span className="o" />
                    <span>{x.content}</span>
                    <span />
                  </div>
                ),
              )}
            </div>
          )}
          {actions.length > 0 && (
            <div className="tape">
              {actions.slice(-5).map((a, i) => (
                <span key={i} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={a.text ?? a.path ?? ""}>
                  {clockSeconds(a.at)} &nbsp;{tapeLine(a)}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="panel" style={{ overflow: "auto" }}>
          <span className="k">Where it has been</span>
          {w.data && <RepoMap files={w.data.files} />}
        </div>
      </div>
    </Shell>
  );
}
