// Flow: everything in motion, as a canal with two locks, and the ledger of what landed.
//
// Work drifts through the canal on its own. There are exactly two gates, and only you
// open them: initials let a plan into the water, the seal lets work out onto main.
// Anything pressed against a gate is outlined in the seal colour; everything in open
// water is grey, because it is moving by itself.

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Boat, LedgerEntry } from "@signet/contracts";
import { api } from "../api.js";
import { Shell } from "./shell.js";
import { Icon } from "./icons.js";
import { navigate, type Route } from "./router.js";
import { SealMark } from "./seal.js";
import { clock, money, plural } from "./format.js";

export function Flow({ route }: { route: Extract<Route, { view: "flow" }> }): ReactNode {
  return (
    <Shell place="flow" title="Flow">
      <div className="subnav" style={{ margin: 0, padding: 0, border: 0 }}>
        <button type="button" className={`tab ${route.tab === "motion" ? "on" : ""}`} onClick={() => navigate({ view: "flow", tab: "motion" })}>
          In motion
        </button>
        <button type="button" className={`tab ${route.tab === "ledger" ? "on" : ""}`} onClick={() => navigate({ view: "flow", tab: "ledger" })}>
          Ledger
        </button>
      </div>
      {route.tab === "motion" ? <Canal /> : <Ledger open={route.open} />}
    </Shell>
  );
}

function openBoat(b: Boat): void {
  if (!b.featureId) return;
  if (b.incrementId && b.yours && b.note.includes("initials")) {
    navigate({ view: "thread", featureId: b.featureId, from: "flow", sheet: { kind: "initial", step: b.incrementId } });
  } else if (b.incrementId && b.yours && b.note.includes("seal")) {
    navigate({ view: "thread", featureId: b.featureId, from: "flow", sheet: { kind: "seal", step: b.incrementId } });
  } else if (b.incrementId && b.progress !== null && b.progress < 100) {
    navigate({ view: "watch", featureId: b.featureId, step: b.incrementId });
  } else {
    navigate({ view: "thread", featureId: b.featureId, from: "flow" });
  }
}

function BoatCard({ b, initials, style }: { b: Boat; initials: string; style?: React.CSSProperties }): ReactNode {
  const done = b.progress === 100 && !b.yours;
  return (
    <button
      type="button"
      className={`boat ${b.yours ? "yours" : ""} ${done ? "done" : ""}`}
      style={{ ...style, textAlign: "left", font: "inherit", color: "inherit", cursor: b.featureId ? "pointer" : "default" }}
      onClick={() => openBoat(b)}
    >
      {done ? (
        <>
          <SealMark size={28} initials={initials} />
          <span>{b.title}</span>
        </>
      ) : (
        <>
          <span>{b.title}</span>
          <span className="f">{b.featureTitle}</span>
          {b.yours ? <span className="f w">{b.note}</span> : b.progress !== null ? <span className="bar"><i style={{ width: `${b.progress}%` }} /></span> : null}
        </>
      )}
    </button>
  );
}

function Canal(): ReactNode {
  const q = useQuery({ queryKey: ["canal"], queryFn: api.canal, refetchInterval: 4000 });
  if (!q.data) return <div className="canal" />;
  const { planned, building, landed, identity } = q.data;
  // Waiting boats sit against the gate; moving ones float in open water.
  const waitingAt = (xs: Boat[]) => xs.filter((b) => b.yours);
  const moving = (xs: Boat[]) => xs.filter((b) => !b.yours);
  const aligns = ["flex-start", "center", "center", "flex-start"] as const;
  return (
    <div className="canal">
      <div className="band" />
      <div className="reach">
        <h4>
          <span>Being planned</span>
          <span>{planned.length}</span>
        </h4>
        <div className="sub">Signet reads the repo and proposes.</div>
        <div className="water">
          {moving(planned).map((b, i) => (
            <BoatCard key={`p${i}`} b={{ ...b, featureTitle: b.note }} initials={identity.initials} />
          ))}
          {waitingAt(planned).map((b, i) => (
            <BoatCard key={`w${i}`} b={b} initials={identity.initials} />
          ))}
        </div>
      </div>
      <div className="gate">
        <span className="lk">
          <Icon.pen />
        </span>
        <span className="doors">
          <i />
          <i />
        </span>
        <span className="gl">
          you
          <br />
          initial
        </span>
      </div>
      <div className="reach">
        <h4>
          <span>Building and checking</span>
          <span>{building.length}</span>
        </h4>
        <div className="sub">Nobody needs to watch. Checks send work back until it passes.</div>
        <div className="water">
          {moving(building).map((b, i) => (
            <BoatCard key={`b${i}`} b={{ ...b, featureTitle: `${b.featureTitle} · ${b.note}` }} initials={identity.initials} style={{ alignSelf: aligns[i % aligns.length] }} />
          ))}
          {waitingAt(building).map((b, i) => (
            <BoatCard key={`y${i}`} b={b} initials={identity.initials} />
          ))}
        </div>
      </div>
      <div className="gate">
        <span className="lk">
          <Icon.lock />
        </span>
        <span className="doors">
          <i />
          <i />
        </span>
        <span className="gl">
          you
          <br />
          seal
        </span>
      </div>
      <div className="reach">
        <h4>
          <span>On main today</span>
          <span>{landed.length}</span>
        </h4>
        <div className="sub">Merged, never pushed.</div>
        <div className="water">
          {landed.map((b, i) => (
            <BoatCard key={`l${i}`} b={b} initials={identity.initials} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── the ledger ──

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? clock(d) : `${d.getDate()} ${d.toLocaleDateString("en-US", { month: "short" })}`;
}

function Ledger({ open }: { open: string | undefined }): ReactNode {
  const q = useQuery({ queryKey: ["ledger"], queryFn: api.ledger, refetchInterval: 10000 });
  const [expanded, setExpanded] = useState<string | undefined>(open);
  if (!q.data) return <div className="ledger" />;
  const { entries, identity } = q.data;
  if (entries.length === 0) {
    return (
      <div className="quiet">
        <div className="big">Nothing sealed yet.</div>
        <div>Every change you seal is kept here as a record: who asked, who initialled, how it was built, who sealed it.</div>
      </div>
    );
  }
  return (
    <div className="ledger" style={{ overflow: "auto" }}>
      {entries.map((e) => (
        <div key={e.incrementId}>
          <div className="lrow" role="button" tabIndex={0} onClick={() => setExpanded(expanded === e.incrementId ? undefined : e.incrementId)} style={{ cursor: "pointer" }}>
            <span>
              <SealMark size={36} initials={identity.initials} trust={e.onTrust > 0} />
            </span>
            <div>
              <div>{e.title}</div>
              <div className="f">{e.featureTitle}</div>
            </div>
            <span className="f" style={e.onTrust > 0 ? { color: "var(--seal)" } : undefined}>
              {e.takenBack
                ? "taken back"
                : e.promises !== null
                  ? `${e.proven} of ${e.promises} proven${e.onTrust > 0 ? ` · ${e.onTrust} on trust` : e.repairs > 0 ? ` · ${e.repairs} ${plural(e.repairs, "repair")}` : ""}`
                  : e.repairs > 0
                    ? `${e.repairs} ${plural(e.repairs, "repair")}`
                    : "not checked"}
            </span>
            <span className="m">{e.sha ? e.sha.slice(0, 7) : "—"}</span>
            <span className="r">{when(e.mergedAt)}</span>
            <span className="r">{money(e.costUsd)}</span>
          </div>
          {expanded === e.incrementId && <Record e={e} signature={identity.signature} />}
        </div>
      ))}
    </div>
  );
}

function Record({ e, signature }: { e: LedgerEntry; signature: string }): ReactNode {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const take = useMutation({
    mutationFn: () => api.takeBack(e.incrementId),
    onSuccess: async (r) => {
      await qc.invalidateQueries();
      navigate({ view: "thread", featureId: r.featureId, sheet: { kind: "seal", step: r.incrementId } });
    },
  });
  const buildMin = e.record.buildMs !== null ? Math.max(1, Math.round(e.record.buildMs / 60_000)) : null;
  return (
    <div className="lrec">
      <div className="steps2">
        <span>
          <b>Asked</b> {clock(e.record.askedAt)} · version {e.record.briefVersion}
          {e.record.answer ? `, with your answer “${e.record.answer}”` : ""}
        </span>
        {e.record.initialledAt && (
          <span>
            <b>Initialled</b> by {signature} · {clock(e.record.initialledAt)}
          </span>
        )}
        <span>
          <b>Built</b> in {e.record.runs === 1 ? "one run" : `${e.record.runs} runs`}
          {e.repairs > 0 ? ` · checks sent it back ${e.repairs === 1 ? "once" : `${e.repairs} times`}` : ""}
          {buildMin !== null ? ` · ${buildMin} min` : ""}
        </span>
        <span>
          <b>Sealed</b> by {signature} · {clock(e.mergedAt)} ·{" "}
          {e.onTrust > 0 ? `${e.onTrust} ${plural(e.onTrust, "promise")} on trust` : e.promises !== null ? "every promise proven" : "promises not checked"}
        </span>
        <span>
          <b>Landed</b> on main{e.sha ? ` as merge commit ${e.sha.slice(0, 7)}` : ""} · not pushed
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
        {e.takenBack ? (
          <span style={{ fontSize: 12, color: "var(--fg-3)" }}>Taken back — its revert is on main.</span>
        ) : confirming ? (
          <>
            <button type="button" className="btn btn-outline" disabled={take.isPending} onClick={() => take.mutate()}>
              <Icon.undo />
              {take.isPending ? "Making the revert…" : "Make the revert"}
            </button>
            <button type="button" className="btn btn-outline" style={{ border: 0 }} onClick={() => setConfirming(false)}>
              cancel
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-outline" onClick={() => setConfirming(true)}>
            <Icon.undo />
            Take it back
          </button>
        )}
        {!e.takenBack && (
          <span style={{ fontSize: 12, color: take.error ? "var(--seal)" : "var(--fg-3)", lineHeight: 1.5 }}>
            {take.error
              ? (take.error as Error).message
              : `Makes a revert commit you seal like any change.${
                  e.builtOnTop.length > 0
                    ? ` ${e.builtOnTop.map((t) => `“${t}”`).join(" and ")} ${e.builtOnTop.length === 1 ? "was" : "were"} built on top of this and would go with it — you see both before anything happens.`
                    : ""
                }`}
          </span>
        )}
      </div>
    </div>
  );
}
