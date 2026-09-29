// The shell: three places and one verb.
//
//   Desk      — decisions waiting on you, and nothing else
//   Flow      — everything in motion, and the ledger of what landed
//   Workshop  — conventions, routines, health
//   Ask       — always there, one key away
//
// The header carries one status line: what is building, what it has spent today, or —
// when the Claude quota has run out — that everything is held and until when.

import type { ReactNode } from "react";
import type { StatusLine } from "@signet/contracts";
import { Icon } from "./icons.js";
import { href, navigate } from "./router.js";
import { useDesk } from "./data.js";
import { clock, money } from "./format.js";
import { asideKey, useAside } from "./desk.js";

export type Place = "desk" | "flow" | "workshop";

export function Shell({
  place,
  title,
  crumb,
  onCrumb,
  status,
  overlay,
  children,
}: {
  place: Place;
  title: string;
  crumb?: string | undefined;
  onCrumb?: (() => void) | undefined;
  /** Replaces the default status line — the morning page says what it spent overnight. */
  status?: ReactNode;
  overlay?: ReactNode;
  children: ReactNode;
}): ReactNode {
  const desk = useDesk();
  const d = desk.data;
  const aside = useAside();
  const waiting = d ? d.decisions.filter((x) => !aside.includes(asideKey(x))).length + d.stopped.length : 0;
  const moving = d ? d.flow.building + d.flow.checking : 0;

  return (
    <div className="shell2" style={{ height: "100%", position: "relative" }}>
      <aside className="rail2">
        <div className="mark">
          <b>Signet</b>
          <span>{d?.repoLabel ?? ""}</span>
        </div>
        <button type="button" className="ask" onClick={() => navigate({ view: "ask" })}>
          <Icon.pen />
          <span style={{ flex: 1 }}>Ask for something</span>
          <span className="kbd">N</span>
        </button>
        <PlaceLink on={place === "desk"} icon={<Icon.inbox />} label="Desk" to={href({ view: "desk" })} n={waiting > 0 ? <span className="n">{waiting}</span> : null} />
        <PlaceLink on={place === "flow"} icon={<Icon.columns />} label="Flow" to={href({ view: "flow", tab: "motion" })} n={moving > 0 ? <span className="n grey">{moving}</span> : null} />
        <PlaceLink on={place === "workshop"} icon={<Icon.wrench />} label="Workshop" to={href({ view: "workshop", tab: "conventions" })} n={null} />
        <div className="foot2">
          <span>
            <span className="kbd">K</span> anything
          </span>
          <span>Your Claude subscription · no API key</span>
        </div>
      </aside>
      <main className="body2">
        <header className="head2">
          {crumb && (
            <>
              <button type="button" className="crumb" onClick={onCrumb} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer" }}>
                {crumb}
              </button>
              <span className="crumb">/</span>
            </>
          )}
          <h1>{title}</h1>
          <div className="status-line">{status ?? (d ? <DefaultStatus s={d.status} quiet={waiting === 0} /> : null)}</div>
        </header>
        <div className="content2">{children}</div>
      </main>
      {overlay}
    </div>
  );
}

function PlaceLink({ on, icon, label, to, n }: { on: boolean; icon: ReactNode; label: string; to: string; n: ReactNode }): ReactNode {
  return (
    <a className={`place ${on ? "on" : ""}`} href={to} aria-current={on ? "page" : undefined}>
      {icon}
      <span>{label}</span>
      {n}
    </a>
  );
}

export function DefaultStatus({ s, quiet }: { s: StatusLine; quiet: boolean }): ReactNode {
  if (s.held) {
    return (
      <>
        <span className="dot-seal" />
        <span>Held · your Claude quota {s.held.resetsAt ? `resets ${clock(s.held.resetsAt)}` : "resets soon"}</span>
      </>
    );
  }
  return (
    <>
      {s.building > 0 && !quiet ? <span className="pulse" /> : <span className="dot-grey" />}
      <span>{s.building > 0 ? `${s.building} building` : "nothing building"}</span>
      <span>·</span>
      <span>{money(s.spentTodayUsd)} today</span>
    </>
  );
}
