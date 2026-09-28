// The Desk: decisions waiting on you, and nothing else.
//
// Four states, from the frames: the morning page after a real absence; the inbox of
// decisions; "Nothing needs you" when it is empty; and held, when the Claude quota has
// run out. Keyboard first — J and K move, Enter opens, E puts one aside for now.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AwaySummary, Decision, DeskView, FlowCounts } from "@signet/contracts";
import { api } from "../api.js";
import { Shell } from "./shell.js";
import { useDesk } from "./data.js";
import { Icon } from "./icons.js";
import { navigate, type Route } from "./router.js";
import { clock, money, plural, span, waited, words } from "./format.js";

// ── when you last looked ──

const SEEN = "signet.lastSeen";
const AWAY_MS = 4 * 60 * 60_000;
const ASIDE = "signet.aside";

function read(key: string, store: Storage | null): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key: string, value: string, store: Storage | null): void {
  try {
    store?.setItem(key, value);
  } catch {
    /* storage blocked: the feature quietly does nothing */
  }
}
const local = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);
const session = (): Storage | null => (typeof sessionStorage === "undefined" ? null : sessionStorage);

/** The previous visit, read once per page load; "now" is kept written while open. */
let previousVisit: string | null | undefined;
function usePreviousVisit(): string | null {
  if (previousVisit === undefined) previousVisit = read(SEEN, local());
  useEffect(() => {
    const seen = () => write(SEEN, new Date().toISOString(), local());
    seen();
    const t = setInterval(seen, 60_000);
    document.addEventListener("visibilitychange", seen);
    window.addEventListener("pagehide", seen);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", seen);
      window.removeEventListener("pagehide", seen);
    };
  }, []);
  return previousVisit;
}

// ── put aside for now (E) — per session, shared with the rail's count ──

const asideListeners = new Set<() => void>();
export function readAside(): string[] {
  const raw = read(ASIDE, session());
  return raw ? raw.split(",") : [];
}
function writeAside(ids: string[]): void {
  write(ASIDE, ids.join(","), session());
  for (const l of asideListeners) l();
}
export const asideKey = (d: Decision): string => `${d.incrementId}:${d.since}`;
export function useAside(): string[] {
  const [aside, setAside] = useState(readAside);
  useEffect(() => {
    const on = () => setAside(readAside());
    asideListeners.add(on);
    return () => void asideListeners.delete(on);
  }, []);
  return aside;
}

let morningDone = false;

export function Desk(): ReactNode {
  const desk = useDesk();
  const previous = usePreviousVisit();
  const [, force] = useState(0);
  const away = !morningDone && previous !== null && Date.now() - Date.parse(previous) >= AWAY_MS;
  const summary = useQuery({
    queryKey: ["away", previous],
    queryFn: () => api.away(previous as string),
    enabled: away,
    staleTime: Infinity,
  });

  const d = desk.data;
  if (!d) return <Shell place="desk" title="Desk">{null}</Shell>;

  if (away && summary.data && summary.data.events.length > 0) {
    return (
      <Shell
        place="desk"
        title="Desk"
        status={
          <>
            <span className={d.status.building > 0 ? "pulse" : "dot-grey"} />
            <span>{d.status.building > 0 ? `${d.status.building} building` : "nothing building"}</span>
            <span>·</span>
            <span>{money(summary.data.spentUsd)} while you were away</span>
          </>
        }
      >
        <Morning
          s={summary.data}
          desk={d}
          onBegin={(r) => {
            morningDone = true;
            force((n) => n + 1);
            navigate(r);
          }}
        />
      </Shell>
    );
  }

  return (
    <Shell place="desk" title="Desk">
      <Inbox d={d} />
    </Shell>
  );
}

// ── the inbox ──

function routeFor(dec: Decision): Route {
  if (dec.kind === "seal") return { view: "thread", featureId: dec.featureId, sheet: { kind: "seal", step: dec.incrementId } };
  if (dec.kind === "initial") return { view: "thread", featureId: dec.featureId, sheet: { kind: "initial", step: dec.incrementId } };
  return { view: "thread", featureId: dec.featureId };
}

function Inbox({ d }: { d: DeskView }): ReactNode {
  const aside = useAside();
  const decisions = useMemo(() => d.decisions.filter((x) => !aside.includes(asideKey(x))), [d.decisions, aside]);
  const [sel, setSel] = useState(0);
  const held = d.status.held;

  useEffect(() => {
    if (sel >= decisions.length) setSel(Math.max(0, decisions.length - 1));
  }, [decisions.length, sel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j") setSel((s) => Math.min(decisions.length - 1, s + 1));
      else if (e.key === "k") setSel((s) => Math.max(0, s - 1));
      else if (e.key === "Enter" && decisions[sel]) navigate(routeFor(decisions[sel]));
      else if (e.key === "e" && decisions[sel]) writeAside([...aside, asideKey(decisions[sel])]);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decisions, sel, aside]);

  const flow = <FlowStrip f={d.flow} />;

  if (decisions.length === 0 && !held) {
    return (
      <>
        {flow}
        <div className="quiet">
          <div className="big">Nothing needs you.</div>
          <div style={{ maxWidth: "52ch", lineHeight: 1.6 }}>
            {d.status.building > 0
              ? `${d.status.building === 1 ? "One step is" : `${words(d.status.building)[0]?.toUpperCase()}${words(d.status.building).slice(1)} steps are`} building on ${d.status.building === 1 ? "its" : "their"} own. You will see ${d.status.building === 1 ? "it" : "them"} here when ${d.status.building === 1 ? "it is" : "they are"} ready to seal, and nowhere else until then.`
              : "Nothing is building. Ask for something, and you will see it here when it needs you — and nowhere else until then."}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-primary" onClick={() => navigate({ view: "ask" })}>
              <Icon.pen />
              Ask for something
            </button>
            {d.status.building > 0 && (
              <button type="button" className="btn btn-outline" onClick={() => navigate({ view: "flow", tab: "motion" })}>
                Watch it work
              </button>
            )}
          </div>
          {d.lastLandedAt && (
            <div style={{ color: "var(--fg-3)", fontSize: 12, marginTop: 16 }}>
              {d.flow.landedToday} {plural(d.flow.landedToday, "step")} sealed today · last one {clock(d.lastLandedAt)}
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {held && <HeldBanner held={held} />}
      {flow}
      {decisions.length > 0 && (
        <div className="inbox">
          {decisions.map((dec, i) => (
            <DecisionRow key={dec.incrementId} dec={dec} sel={i === sel} held={held !== null} heldUntil={held?.resetsAt ?? null} onOpen={() => navigate(routeFor(dec))} />
          ))}
        </div>
      )}
      {!held && (
        <div style={{ display: "flex", gap: 16, color: "var(--fg-3)", fontSize: 12 }}>
          <span>
            <span className="kbd">J</span> <span className="kbd">K</span> move
          </span>
          <span>
            <span className="kbd">↵</span> review
          </span>
          <span>
            <span className="kbd">E</span> done for now
          </span>
          <span style={{ marginLeft: "auto" }}>Grey means handled. Colour means you.</span>
        </div>
      )}
    </>
  );
}

export function FlowStrip({ f }: { f: FlowCounts }): ReactNode {
  const cols: Array<[string, boolean, number]> = [
    ["Asked", false, f.asked],
    ["To initial", true, f.toInitial],
    ["Building", false, f.building],
    ["Checking", false, f.checking],
    ["To seal", true, f.toSeal],
    ["Landed today", false, f.landedToday],
  ];
  return (
    <div className="flowstrip">
      {cols.map(([label, yours, n]) => (
        <div key={label} className={`fcol ${yours ? "yours" : ""}`}>
          <div className="lab">{label}</div>
          <div className="num">{n}</div>
        </div>
      ))}
    </div>
  );
}

function DecisionRow({
  dec,
  sel,
  held,
  heldUntil,
  onOpen,
}: {
  dec: Decision;
  sel: boolean;
  held: boolean;
  heldUntil: string | null;
  onOpen: () => void;
}): ReactNode {
  const { what, why, meta, act } = decisionWords(dec, held, heldUntil);
  return (
    <div className={`dec ${sel ? "sel" : ""}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <span className={dec.kind === "seal" || dec.kind === "initial" || dec.kind === "question" || dec.kind === "failed" ? "dot-seal" : "dot-grey"} />
      <div style={{ minWidth: 0 }}>
        <div className="what">{what}</div>
        <div className="why">{why}</div>
        <div className="meta">{meta}</div>
      </div>
      <div className="acts">
        {sel && !held && <span className="kbd">↵</span>}
        <button
          type="button"
          className={`btn ${act.seal ? "btn-seal" : "btn-outline"}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {act.label}
        </button>
      </div>
    </div>
  );
}

/** The words a decision is written in — exported so the tests pin them. */
export function decisionWords(
  dec: Decision,
  held: boolean,
  heldUntil: string | null,
): { what: string; why: string; meta: string; act: { label: string; seal: boolean } } {
  const w = waited(dec.since);
  switch (dec.kind) {
    case "seal": {
      const repairs = dec.repairs === 0 ? "" : `, ${dec.repairs === 1 ? "one repair" : `${words(dec.repairs)} repairs`} along the way`;
      const facts = [
        dec.files !== null ? `${dec.files} ${plural(dec.files, "file")} · +${dec.added ?? 0} −${dec.removed ?? 0}` : null,
        dec.promises !== null ? `${dec.proven} of ${dec.promises} promises proven` : null,
        `waiting ${w}`,
        held ? "sealing lands it now, no quota needed" : null,
      ].filter(Boolean);
      return {
        what: `Seal “${dec.stepTitle}”`,
        why: held ? `${dec.featureTitle} · built before the quota ran out` : `${dec.featureTitle} · every check passed${repairs}`,
        meta: facts.join(" · "),
        act: { label: "Review and seal", seal: true },
      };
    }
    case "initial":
      return {
        what: `Initial the plan for “${dec.stepTitle}”`,
        why: held
          ? `will start at ${heldUntil ? clock(heldUntil) : "the reset"} once initialled`
          : `${dec.featureTitle} · step ${dec.stepIndex} of ${dec.stepCount} · ${dec.spentUsd ? `${money(dec.spentUsd)} spent` : "nothing spent yet"}`,
        meta: held ? `waiting ${w}` : `may change ${dec.surface.join(", ")} · waiting ${w}`,
        act: { label: "Review", seal: false },
      };
    case "question":
      return {
        what: `Signet asked: ${dec.text ?? "a question"}`,
        why: `${dec.stepTitle} · it stopped rather than guess`,
        meta: `asked ${w} ago`,
        act: { label: "Answer", seal: false },
      };
    case "failed":
      return {
        what: `“${dec.stepTitle}” stopped with a failure`,
        why: `${dec.featureTitle} · ${dec.text ?? "the run failed"}`,
        meta: `failed ${w} ago`,
        act: { label: "Look", seal: false },
      };
  }
}

function HeldBanner({ held }: { held: NonNullable<DeskView["status"]["held"]> }): ReactNode {
  const now = Date.now();
  const resets = held.resetsAt ? Date.parse(held.resetsAt) : null;
  const start = held.windowStart ? Date.parse(held.windowStart) : null;
  return (
    <div className="now yours" style={{ marginTop: 0 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <span className="dot-seal" />
        <b>Nothing can build until {held.resetsAt ? clock(held.resetsAt) : "your quota resets"}</b>
      </div>
      <div style={{ color: "var(--fg-2)", fontSize: 13, lineHeight: 1.6 }}>
        Your Claude quota is used up for this window.{" "}
        {held.queued > 0
          ? `The ${held.queued === 1 ? "waiting step starts" : `${words(held.queued)} waiting steps start`} by ${held.queued === 1 ? "itself" : "themselves"} when it comes back.`
          : "Anything you start will wait for it to come back."}{" "}
        Sealing needs no quota — it is git, not the model — so this is a good time to clear your Desk.
      </div>
      {resets !== null && (
        <div className="qwin">
          <div className="qbar">
            <div className="used">{start !== null ? `used since ${clock(new Date(start))}` : "used"}</div>
            <div className="wait">{span(resets - now)} to go</div>
            <div className="queued">
              {Array.from({ length: Math.min(held.queued, 6) }, (_, i) => (
                <i key={i} />
              ))}
              {held.queued === 0 ? "then anything can start" : held.queued === 1 ? "then this starts" : "then these start"}
            </div>
          </div>
          <div className="qlab">
            <span>{start !== null ? clock(new Date(start)) : ""}</span>
            <span>now · {clock(new Date(now))}</span>
            <span>{clock(new Date(resets))} · quota back</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── the morning page ──

function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
}

function Morning({ s, desk, onBegin }: { s: AwaySummary; desk: DeskView; onBegin: (r: Route) => void }): ReactNode {
  const seals = desk.decisions.filter((x) => x.kind === "seal");
  const start = s.startWith ? desk.decisions.find((x) => x.incrementId === s.startWith?.incrementId) : null;
  const from = Date.parse(s.since);
  const to = Date.parse(s.until);
  const pos = (iso: string) => ((Date.parse(iso) - from) / Math.max(1, to - from)) * 100;

  // Hour marks on whole hours, about six across the absence.
  const hours: number[] = [];
  const stepH = Math.max(1, Math.round((to - from) / 3600_000 / 5));
  const first = new Date(from);
  first.setMinutes(0, 0, 0);
  for (let t = first.getTime() + 3600_000; t < to; t += stepH * 3600_000) hours.push(t);

  // Which events get a label: yours first, then the rest, never two closer than 14%.
  const labelled = new Set<number>();
  const order = s.events.map((e, i) => ({ i, p: pos(e.at), yours: e.yours })).sort((a, b) => Number(b.yours) - Number(a.yours) || a.p - b.p);
  const taken: number[] = [];
  for (const c of order) {
    if (taken.every((t) => Math.abs(t - c.p) >= 14)) {
      taken.push(c.p);
      labelled.add(c.i);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && start) {
        e.preventDefault();
        onBegin(routeFor(start));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [start, onBegin]);

  return (
    <div className="brief">
      <div className="hello">{greeting()}</div>
      <div className="para">{morningSentence(s)}</div>
      <div className="night">
        {hours.map((t) => (
          <span key={t} className="hr" style={{ left: `${((t - from) / (to - from)) * 100}%` }}>
            {new Date(t).toLocaleTimeString("en-US", { hour: "numeric" }).toLowerCase().replace(/\s/g, " ")}
          </span>
        ))}
        {s.events.map((e, i) => {
          const p = pos(e.at);
          const showLabel = labelled.has(i);
          return (
            <span key={i}>
              <span className={`mk ${e.yours ? "you" : ""}`} style={{ left: `${p}%` }} />
              {showLabel && (
                <span className="lb" style={{ left: `${Math.min(92, Math.max(7, p))}%` }}>
                  <b>{clock(e.at)}</b>
                  {e.text}
                </span>
              )}
            </span>
          );
        })}
      </div>
      {s.startWith && (
        <div className="dec sel" style={{ marginTop: 4 }} role="button" tabIndex={0}
          onClick={() => start && onBegin(routeFor(start))}
        >
          <span className="dot-seal" />
          <div>
            <div className="what">Start with “{s.startWith.title}”</div>
            <div className="why">{s.startWith.why}</div>
            {start && <div className="meta">{decisionWords(start, false, null).meta.replace(/ · waiting .*$/, "")}</div>}
          </div>
          <div className="acts">
            <button type="button" className="btn btn-seal" onClick={(e) => { e.stopPropagation(); if (start) onBegin(routeFor(start)); }}>
              Go through all {seals.length}
            </button>
            <span className="kbd">↵</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The paragraph, in the wireframe's order: built and waiting, questions, routines, and the promise. */
export function morningSentence(s: AwaySummary): ReactNode {
  const built = s.events.filter((e) => e.kind === "built" && e.yours).length;
  const questions = s.events.filter((e) => e.kind === "question" && e.yours).length;
  const routines = s.events.filter((e) => e.kind === "routine");
  const parts: ReactNode[] = [];
  if (built > 0) parts.push(<b key="b">{built === 1 ? "one step was built and is waiting for your seal" : `${words(built)} steps were built and are waiting for your seal`}</b>);
  if (questions > 0) parts.push(<b key="q">{questions === 1 ? "one step stopped to ask you something" : `${words(questions)} steps stopped to ask you something`}</b>);
  for (const r of routines.slice(0, 2)) parts.push(<span key={r.at}>{r.text.replace(/^“/, "the routine “")}</span>);
  const joined: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (i > 0) joined.push(i === parts.length - 1 ? ", and " : ", ");
    joined.push(p);
  });
  return (
    <>
      {parts.length > 0 ? <>While you were away, {joined}. </> : <>While you were away, nothing needed you. </>}
      <b>Nothing reached main without you.</b>
      {s.spentUsd !== null && s.spentUsd > 0 && <> It spent {money(s.spentUsd)}.</>}
    </>
  );
}
