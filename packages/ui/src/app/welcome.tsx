// First run: one question, full screen, in the product's own voice. There is no
// navigation yet because there is nothing to navigate — the three places appear once
// there is a repo to work in.

import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RepoOption } from "@signet/contracts";
import { api } from "../api.js";
import { Icon, Tick } from "./icons.js";
import { navigate, type Route } from "./router.js";

const CURRENT = "signet.repo";
export function currentRepo(): string | undefined {
  try {
    return localStorage.getItem(CURRENT) ?? undefined;
  } catch {
    return undefined;
  }
}
function setCurrentRepo(id: string): void {
  try {
    localStorage.setItem(CURRENT, id);
  } catch {
    /* storage blocked: the configured repo stays the default */
  }
}

function Bare({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="shell2" style={{ height: "100%", display: "block", overflow: "auto" }}>
      <div className="content2" style={{ height: "auto", overflow: "visible" }}>
        {children}
      </div>
    </div>
  );
}

export function Welcome({ route }: { route: Extract<Route, { view: "welcome" }> }): ReactNode {
  return route.repoId ? <PortraitPage repoId={route.repoId} /> : <Pick />;
}

const home = (p: string | null) => (p ?? "").replace(/^\/Users\/[^/]+/, "~");
const nameOf = (r: RepoOption) => (r.origin === "github" ? r.label : (r.path ?? r.label).split("/").filter(Boolean).pop() ?? r.label);

/** The line under a repo's name: where it is, which branch, how big, whether it has tests. */
function RepoRow({ r, on, onPick }: { r: RepoOption; on: boolean; onPick: () => void }): ReactNode {
  const g = useQuery({ queryKey: ["glance", r.id], queryFn: () => api.glance(r.id), enabled: r.origin === "local", staleTime: 60_000 });
  const empty = g.data !== undefined && g.data.files === 0;
  const detail =
    r.origin === "github"
      ? "on GitHub · plan only — landing work there means pushing, which Signet does not do yet"
      : g.data
        ? empty
          ? `${home(r.path)} · no source code found`
          : `${home(r.path)} · on ${g.data.branch} · ${g.data.files} files · ${g.data.tests ? "tests found" : "no tests found — I can plan here, but my checks will have little to go on"}`
        : home(r.path);
  return (
    <button
      type="button"
      className={`reporow ${on ? "sel" : ""} ${empty ? "dim" : ""}`}
      onClick={onPick}
      style={{ width: "100%", border: 0, borderBottom: "1px solid var(--line-1)", background: on ? "var(--ink-2)" : "transparent", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer" }}
    >
      <span className={`radio ${on ? "on" : ""}`} />
      <div>
        <div>{nameOf(r)}</div>
        <div className="d">{detail}</div>
      </div>
      <span className="crumb">{r.origin === "github" ? "GitHub" : (g.data?.changed ?? "")}</span>
    </button>
  );
}

function Pick(): ReactNode {
  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repoOptions, staleTime: 60_000 });
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const list = (repos.data?.repos ?? []).slice(0, 8);
  const pick = chosen ?? list.find((r) => r.isConfigured)?.id ?? list[0]?.id;
  const picked = list.find((r) => r.id === pick);
  const roots = repos.data?.scannedRoots[0]?.replace(/^\/Users\/[^/]+/, "~") ?? "~/code";
  return (
    <Bare>
      <div className="first">
        <div className="mark" style={{ padding: 0 }}>
          <b>Signet</b>
        </div>
        <h2>What should I work on?</h2>
        <p className="lead">
          Point me at a repository on this machine. I will only read it — nothing is changed, nothing is installed, and nothing is sent anywhere except through your own Claude Code login.
        </p>
        <div
          className="dropz"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            // A browser is told a dropped folder's name, never its path — so it is matched
            // against the repos found on this machine.
            const name = e.dataTransfer.files[0]?.name;
            const hit = (repos.data?.repos ?? []).find((r) => r.label === name || r.path?.endsWith(`/${name}`));
            if (hit) {
              setChosen(hit.id);
              setDropNote(null);
            } else setDropNote(name ? `I cannot see where “${name}” is. Pick it below, or put it under ${roots}.` : null);
          }}
        >
          <Icon.folder />
          <span>{dropNote ?? <>Drop a folder here, or pick one I found in <span className="mono">{roots}</span></>}</span>
        </div>
        <div className="repolist">
          {list.map((r) => (
            <RepoRow key={r.id} r={r} on={pick === r.id} onPick={() => setChosen(r.id)} />
          ))}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button type="button" className="btn btn-primary" disabled={!picked} onClick={() => picked && navigate({ view: "welcome", repoId: picked.id })}>
            Read {picked ? nameOf(picked) : "it"}
          </button>
          <span style={{ color: "var(--fg-3)", fontSize: 12 }}>About 20 seconds. Free — reading is not a model call.</span>
        </div>
      </div>
    </Bare>
  );
}

function PortraitPage({ repoId }: { repoId: string }): ReactNode {
  const qc = useQueryClient();
  const p = useQuery({ queryKey: ["portrait", repoId], queryFn: () => api.portrait(repoId) });
  const last = useQuery({ queryKey: ["baseline", repoId], queryFn: () => api.lastBaseline(repoId) });
  const run = useMutation({ mutationFn: () => api.runBaseline(repoId), onSuccess: (r) => qc.setQueryData(["baseline", repoId], r) });
  const [pick, setPick] = useState<number | null>(null);
  const note = useMutation({ mutationFn: (n: string) => api.repoNote(n, repoId), onSuccess: () => void qc.invalidateQueries({ queryKey: ["portrait", repoId] }) });

  // The checks run once on main when you arrive, unless they ran in the last few hours.
  const fresh = last.data && Date.now() - Date.parse(last.data.checkedAt) < 6 * 3600_000;
  useEffect(() => {
    if (last.isFetched && !fresh && !run.isPending && !run.data && !run.error) run.mutate();
  }, [last.isFetched, fresh, run]);
  const report = run.data ?? last.data ?? null;

  if (!p.data) {
    return (
      <Bare>
        <div className="first">
          <h2 style={{ fontSize: 38 }}>Reading…</h2>
        </div>
      </Bare>
    );
  }
  const d = p.data;
  const chosen = pick ?? d.doubt?.suggested ?? null;
  return (
    <Bare>
      <div className="first" style={{ maxWidth: 860, gap: 16 }}>
        <h2 style={{ fontSize: 38 }}>Here is {d.path.split("/").filter(Boolean).pop() ?? d.label}, as I read it.</h2>
        <div className="portrait">
          {d.pieces.map((x, i) =>
            x.fact ? (
              <span key={i} className={`fact ${x.unsure ? "unsure" : ""}`}>
                {x.text}
              </span>
            ) : (
              <span key={i}>{x.text}</span>
            ),
          )}
        </div>
        {d.doubt && (
          <div className="doubt" style={{ margin: 0, maxWidth: 640 }}>
            <span className="qm">?</span>
            <div>
              {d.doubt.question}
              <div className="choice-row">
                {d.doubt.options.map((o, i) => (
                  <button
                    key={o}
                    type="button"
                    className={`choice ${chosen === i ? "on" : ""}`}
                    onClick={() => {
                      setPick(i);
                      if (!o.endsWith("…")) note.mutate(i === 0 ? o.replace(/, as you guessed$/, "") : o);
                    }}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        <div style={{ fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--fg-3)", marginTop: 4 }}>
          How I will check work here — {run.isPending ? "running once on main now…" : "run once on main just now"}
        </div>
        <div className="checks">
          {(report?.checks ?? []).map((c) => (
            <div key={c.check} className="checkrow">
              <span>{c.check === "typecheck" ? "Types" : c.check === "lint" ? "Lint" : "Tests"}</span>
              <span className="cmd">{c.command ?? "—"}</span>
              <span className="res">
                {c.outcome === "pass" ? (
                  <>
                    <Tick />
                    passes on main · {(c.durationMs / 1000).toFixed(1)} s
                  </>
                ) : c.outcome === "cannot_run" ? (
                  <span className="seal">cannot run here: {c.detail}</span>
                ) : c.outcome === "fail" ? (
                  <span className="seal">{c.detail}</span>
                ) : (
                  c.detail
                )}
              </span>
            </div>
          ))}
          {!report && (
            <div className="checkrow">
              <span>Checks</span>
              <span className="cmd">—</span>
              <span className="res">{run.error ? `could not run: ${(run.error as Error).message}` : "running…"}</span>
            </div>
          )}
        </div>
        {d.asks.length > 0 && (
          <>
            <div style={{ fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--fg-3)", marginTop: 4 }}>Good first asks — small, and each one is checkable</div>
            <div className="starter">
              {d.asks.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => {
                    setCurrentRepo(repoId);
                    try {
                      sessionStorage.setItem("signet.askDraft", a);
                    } catch {
                      /* the ask just starts empty */
                    }
                    navigate({ view: "ask" });
                  }}
                  style={{ border: "1px solid var(--line-2)", borderRadius: 999, padding: "6px 14px", fontSize: 13, color: "var(--fg-1)", background: "var(--ink-1)", cursor: "pointer", font: "inherit" }}
                >
                  {a}
                </button>
              ))}
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 4 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setCurrentRepo(repoId);
              navigate({ view: "desk" });
            }}
          >
            That is right · start
          </button>
          <span style={{ color: "var(--fg-3)", fontSize: 12 }}>Or ask for anything — these are suggestions, not a queue.</span>
        </div>
      </div>
    </Bare>
  );
}

