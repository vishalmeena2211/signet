// A feature as one timeline: asked, proposed, initialled, built, questioned, fixed,
// sealed. What is happening now is pinned at the bottom, like the latest message.
// Your events are solid dots; Signet's are hollow; a question waiting on you is the seal.
//
// The side column holds what stays true — the steps, what it has cost, which repo — or,
// when a question is open, why it asked; or, while the checks are repairing, the budget.

import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EscalationView, ThreadEvent, ThreadView } from "@signet/contracts";
import { api } from "../api.js";
import { Shell } from "./shell.js";
import { navigate, type Route } from "./router.js";
import { clock, elapsed, money, plural } from "./format.js";
import { RepoMap } from "./repomap.js";
import { StepSheetOverlay } from "./sheets.js";

export const PHASE_WORDS: Record<string, string> = {
  ASSEMBLE_PACK: "gathering what it needs",
  CREATE_WORKSPACE: "making its own copy",
  AGENT_PLAN: "planning",
  SCOPE_CHECK: "checking the plan’s files",
  AGENT_IMPLEMENT: "writing the code",
  GATES: "running the checks",
  FINALIZE: "wrapping up",
};

function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function EventRow({ e }: { e: ThreadEvent }): ReactNode {
  return (
    <div className={`ev2 ${e.who === "you" ? "you" : e.who === "ask" ? "ask" : ""}`}>
      <div className="tm">{clock(e.at)}</div>
      <div className="spine">
        <i />
        <u />
      </div>
      <div>
        <div className="et">{e.title}</div>
        {(e.detail || e.lines.length > 0) && (
          <div className="ed">
            {e.detail}
            {e.lines.map((l, i) => (
              <span key={i}>
                {(e.detail || i > 0) && <br />}
                <span className="mono" style={{ fontSize: 12 }}>
                  {l}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Thread({ route }: { route: Extract<Route, { view: "thread" }> }): ReactNode {
  const q = useQuery({ queryKey: ["thread", route.featureId], queryFn: () => api.thread(route.featureId), refetchInterval: 4000 });
  const f = useQuery({ queryKey: ["feature", route.featureId], queryFn: () => api.feature(route.featureId), refetchInterval: 5000 });
  const t = q.data;
  const open = f.data?.escalations[0];
  const crumbTo: Route = route.from === "flow" ? { view: "flow", tab: "motion" } : { view: "desk" };
  const overlay = route.sheet ? (
    <StepSheetOverlay
      featureId={route.featureId}
      sheet={route.sheet}
      from={route.from}
      onClose={() => navigate({ view: "thread", featureId: route.featureId, from: route.from })}
    />
  ) : null;

  // W opens "Watch it work" for the step being built.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.key === "w" && t?.now && !e.metaKey && !e.ctrlKey) navigate({ view: "watch", featureId: route.featureId, step: t.now.incrementId });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t?.now, route.featureId]);

  return (
    <Shell
      place={route.from === "flow" ? "flow" : "desk"}
      title={t?.title ?? ""}
      crumb={route.from === "flow" ? "Flow" : "Desk"}
      onCrumb={() => navigate(crumbTo)}
      overlay={overlay}
    >
      {t && (open?.fence ? <FenceLayout t={t} q={{ ...open, fence: open.fence }} /> : <Timeline t={t} open={open} />)}
    </Shell>
  );
}

function Timeline({ t, open }: { t: ThreadView; open: EscalationView | undefined }): ReactNode {
  const now = useTick(t.now !== null);
  const live = t.steps.find((s) => s.id === t.now?.incrementId);
  return (
    <div className="threadwrap">
      <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div className="thread" style={{ overflow: "auto" }}>
          {t.events.map((e, i) => (
            <EventRow key={i} e={e} />
          ))}
        </div>
        {open ? (
          <Question q={open} />
        ) : !t.now && t.steps.some((s) => s.dismissable) ? (
          <Failed t={t} />
        ) : (
          t.now && (
            <div className="now">
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span className="pulse" />
                <b>
                  Step {t.now.stepIndex} · {t.now.stepTitle}
                </b>
                <span className="crumb" style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
                  {PHASE_WORDS[t.now.phase] ?? t.now.phase} · {elapsed(t.now.phaseEnteredAt, now)}
                </span>
              </div>
              <div className="phases">
                {t.now.phases.map((c, i) => (
                  <i key={i} className={c} />
                ))}
              </div>
              <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--fg-3)", fontVariantNumeric: "tabular-nums" }}>
                {t.now.doing && <span>{t.now.doing}</span>}
                <span>{money(t.now.spentUsd)} so far</span>
                <button
                  type="button"
                  onClick={() => t.now && navigate({ view: "watch", featureId: t.featureId, step: t.now.incrementId })}
                  style={{ marginLeft: "auto", border: 0, background: "transparent", color: "inherit", padding: 0, cursor: "pointer", fontSize: 12 }}
                >
                  Watch it work <span className="kbd">W</span>
                </button>
              </div>
            </div>
          )
        )}
      </div>
      <aside className="side2">
        {open ? (
          <div className="facts2">
            <span className="k">Why it asked</span>
            <span style={{ fontSize: 13, lineHeight: 1.55, color: "var(--fg-2)" }}>
              {open.why ?? "It could not settle this from what you asked for, and a guess would be a decision made for you."}
            </span>
          </div>
        ) : live && live.repairs > 0 ? (
          <div className="facts2">
            <span className="k">Repairs</span>
            <span>{live.repairs} of 3 used</span>
            <span style={{ color: "var(--fg-3)", fontSize: 12 }}>After 3 it tries once from a clean copy, then stops and asks you.</span>
          </div>
        ) : (
          <>
            <div className="facts2">
              <span className="k">Steps</span>
              {t.steps.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    if (s.status === "CONTEXT_READY") navigate({ view: "thread", featureId: t.featureId, sheet: { kind: "initial", step: s.id } });
                    else if (s.status === "AWAITING_SIGNATURE" || s.status === "MERGED") navigate({ view: "thread", featureId: t.featureId, sheet: { kind: "seal", step: s.id } });
                  }}
                  style={{ display: "flex", gap: 8, border: 0, background: "transparent", color: "inherit", padding: 0, textAlign: "left", cursor: "pointer", font: "inherit" }}
                >
                  <span className={s.yours ? "dot-seal" : "dot-grey"} style={{ marginTop: 6 }} />
                  <div>
                    <div>{s.title}</div>
                    <div style={{ color: s.yours ? "var(--seal)" : "var(--fg-3)", fontSize: 12 }}>{s.said}</div>
                  </div>
                </button>
              ))}
            </div>
            <div className="facts2">
              <span className="k">So far</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {money(t.spentUsd)} · {t.runs} {plural(t.runs, "run")} · {t.repairs} {plural(t.repairs, "repair")}
              </span>
            </div>
            <div className="facts2">
              <span className="k">Repo</span>
              <span className="mono">{t.repoLabel}</span>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

/** A failed step, pinned where "now" would be, until it is put away. */
function Failed({ t }: { t: ThreadView }): ReactNode {
  const qc = useQueryClient();
  const step = t.steps.find((s) => s.dismissable);
  const dismiss = useMutation({
    mutationFn: (id: string) => api.dismiss(id),
    onSuccess: () => void qc.invalidateQueries(),
  });
  if (!step) return null;
  const n = t.steps.indexOf(step) + 1;
  return (
    <div className="now yours">
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <span className="dot-seal" />
        <b>
          Step {n} · “{step.title}” stopped with a failure
        </b>
        <button
          type="button"
          className="btn btn-outline"
          style={{ marginLeft: "auto" }}
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate(step.id)}
        >
          Dismiss
        </button>
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Dismissing takes it off your Desk. It stays in this thread, and can still be tried again.</div>
    </div>
  );
}

/** A question in the thread, answered in place. */
function Question({ q }: { q: EscalationView }): ReactNode {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const answer = useMutation({
    mutationFn: (a: string) => api.answerEscalation(q.id, a),
    onSuccess: () => void qc.invalidateQueries(),
  });
  return (
    <div className="now yours">
      <div style={{ fontSize: 14, lineHeight: 1.6 }}>{q.question}</div>
      {q.options && q.options.length > 0 && (
        <div className="choice-row">
          {q.options.map((o) => (
            <button key={o} type="button" className="choice" disabled={answer.isPending} onClick={() => answer.mutate(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <div className="composer" style={{ marginTop: 4, padding: "8px 12px" }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && text.trim()) {
              e.preventDefault();
              answer.mutate(text.trim());
            }
          }}
          placeholder="Or answer in your own words…"
          rows={1}
          style={{ background: "transparent", border: 0, color: "var(--fg-1)", font: "inherit", fontSize: 14, resize: "none", outline: "none" }}
        />
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 12, color: answer.error ? "var(--seal)" : "var(--fg-3)" }}>
        <span>
          {answer.error
            ? `That did not go through: ${(answer.error as Error).message}`
            : "Your answer becomes part of what you asked for, and the step starts again from where it stopped."}
        </span>
      </div>
    </div>
  );
}

const FENCE_CHOICES = [
  { choice: "widen", b: "Widen the fence", rest: (f: string) => `to include ${f} · you initial the change · it carries on` },
  { choice: "split", b: "Make it its own step", rest: () => "· it goes before this one, and both wait for your initials" },
  { choice: "stay", b: "Stay inside", rest: () => "· find a way that only changes the files it may" },
] as const;

/** "It reached outside the fence": the reason, three ways forward, and the map. */
function FenceLayout({ t, q }: { t: ThreadView; q: EscalationView & { fence: NonNullable<EscalationView["fence"]> } }): ReactNode {
  const qc = useQueryClient();
  const step = t.steps.find((s) => s.id === q.incrementId);
  const work = useQuery({
    queryKey: ["work", step?.runId],
    queryFn: () => api.runWork(step?.runId as string),
    enabled: Boolean(step?.runId),
  });
  const answer = useMutation({
    mutationFn: (choice: "widen" | "split" | "stay") => api.answerFence(q.id, choice),
    onSuccess: () => void qc.invalidateQueries(),
  });
  const files = q.fence.outside.join(", ");
  const stepEvents = t.events.filter((e) => e.incrementId === q.incrementId).slice(-2);
  return (
    <div style={{ flex: 1, display: "grid", gridTemplateColumns: "minmax(0,1fr) 420px", gap: 24, overflow: "hidden" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="thread">
          {stepEvents.map((e, i) => (
            <EventRow key={i} e={e} />
          ))}
        </div>
        <div className="now yours">
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>
            {q.fence.reason ? (
              <>
                <b>Why it wanted to:</b> {q.fence.reason}{" "}
              </>
            ) : (
              <>
                <b>It did not say why.</b>{" "}
              </>
            )}
            It stopped instead of changing a file you had not agreed to.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {FENCE_CHOICES.map((c) => (
              <button
                key={c.choice}
                type="button"
                className="choice"
                disabled={answer.isPending}
                onClick={() => answer.mutate(c.choice)}
                style={{ display: "block", padding: "10px 12px", textAlign: "left", color: "var(--fg-1)" }}
              >
                <b>{c.b}</b> {c.rest(files)}
              </button>
            ))}
          </div>
          {answer.error && <div style={{ color: "var(--seal)", fontSize: 12 }}>That did not go through: {(answer.error as Error).message}</div>}
        </div>
      </div>
      <div className="panel">
        <span className="k">Where it reached</span>
        {work.data && <RepoMap files={work.data.files} />}
      </div>
    </div>
  );
}
