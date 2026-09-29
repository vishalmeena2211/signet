// Ask: a conversation that ends in a plan you initial.
//
// You describe what you want. Signet reads the repo, visibly — the survey's findings,
// file by file — then asks what it would otherwise have to guess, with its own answers
// pre-selected. Then it proposes steps: each with the files it may change drawn as a
// fence, what "done" promises, and any doubt pinned to the step it affects. Nothing is
// created until you initial it, and initialling starts the first step.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AskQuestions, AskSurvey, FeatureProposalResponse, SurfaceWarning } from "@signet/contracts";
import { api } from "../api.js";
import { Shell } from "./shell.js";
import { Icon } from "./icons.js";
import { navigate } from "./router.js";
import { useDesk } from "./data.js";
import { money, words } from "./format.js";
import { acceptanceOf, moveFile, moveStep, replaceFile, splitStep, toDraft, type DraftStep } from "./plan.js";
import { currentRepo } from "./welcome.js";
import { Inline } from "./inline.js";

type Phase = "compose" | "reading" | "questions" | "proposing" | "proposal";

export function Ask(): ReactNode {
  const qc = useQueryClient();
  const desk = useDesk();
  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repoOptions, staleTime: 60_000 });
  const [repoId, setRepoId] = useState<string | undefined>(currentRepo);
  const configured = repos.data?.repos.find((r) => r.isConfigured);
  // A repo chosen by typing its path is not in the list the scan found; it is still the
  // repo the work goes to, so it is what the page shows, never the configured one.
  const listed = repos.data?.repos.find((r) => r.id === (repoId ?? configured?.id));
  const repo = listed ?? (repoId ? { id: repoId, label: repoId.replace(/^\/Users\/[^/]+/, "~") } : configured);
  const effectiveRepo = repoId ?? configured?.id;

  const [phase, setPhase] = useState<Phase>("compose");
  const [messages, setMessages] = useState<string[]>([]);
  const [askedAt, setAskedAt] = useState<string | null>(null);
  const [survey, setSurvey] = useState<AskSurvey | null>(null);
  const [questions, setQuestions] = useState<AskQuestions | null>(null);
  const [picks, setPicks] = useState<number[]>([]);
  const [proposal, setProposal] = useState<FeatureProposalResponse | null>(null);
  const [proposedAt, setProposedAt] = useState<string | null>(null);
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [originalCount, setOriginalCount] = useState(0);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [reshaping, setReshaping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const goal = messages.join("\n\n");
  const estimate = useQuery({ queryKey: ["estimate", effectiveRepo], queryFn: () => api.estimate(effectiveRepo) });

  const propose = useMutation({
    mutationFn: (answers: Array<{ question: string; answer: string }>) =>
      api.propose({ goal, ...(effectiveRepo ? { repoId: effectiveRepo } : {}), ...(answers.length ? { answers } : {}) }),
    onMutate: () => {
      setPhase("proposing");
      setError(null);
    },
    onSuccess: (res) => {
      setProposal(res);
      setProposedAt(new Date().toISOString());
      const drafts = res.proposal.steps.map(toDraft);
      // Doubts that belong to no single step are pinned to the first, so none is hidden.
      if (drafts[0] && res.proposal.uncertainties.length > 0) {
        drafts[0] = {
          ...drafts[0],
          doubts: [...drafts[0].doubts, ...res.proposal.uncertainties.map((u) => ({ question: u, options: [], suggested: null }))],
          picks: [...drafts[0].picks, ...res.proposal.uncertainties.map(() => null)],
        };
      }
      setSteps(drafts);
      setOriginalCount(drafts.length);
      setDismissed([]);
      setPhase("proposal");
    },
    onError: (e) => {
      setError((e as Error).message);
      setPhase(questions ? "questions" : "compose");
    },
  });

  const start = async (text: string) => {
    setMessages([text]);
    setAskedAt(new Date().toISOString());
    setPhase("reading");
    setSurvey(null);
    setQuestions(null);
    setProposal(null);
    setError(null);
    try {
      const [s, q] = await Promise.all([api.askSurvey(effectiveRepo).then((x) => (setSurvey(x), x)), api.askQuestions(text, effectiveRepo)]);
      void s;
      setQuestions(q);
      setPicks(q.questions.map((x) => x.suggested));
      if (q.questions.length === 0) propose.mutate([]);
      else setPhase("questions");
    } catch (e) {
      setError((e as Error).message);
      setPhase("compose");
    }
  };

  const answers = () => (questions?.questions ?? []).map((q, i) => ({ question: q.question, answer: q.options[picks[i] ?? q.suggested] ?? "" }));

  const create = useMutation({
    mutationFn: async () => {
      if (!proposal) throw new Error("no proposal");
      const doubtLines = steps.flatMap((s) =>
        s.doubts.map((d, i) => {
          const pick = s.picks[i];
          return `- ${d.question} → ${pick !== null && pick !== undefined && d.options[pick] ? d.options[pick] : "left to Signet"}`;
        }),
      );
      const briefMd = [
        "## What you asked",
        goal,
        "",
        "## What Signet understood",
        proposal.proposal.understanding,
        ...(answers().length > 0 ? ["", "## Your answers before the plan", ...answers().map((a) => `- ${a.question} → ${a.answer}`)] : []),
        ...(doubtLines.length > 0 ? ["", "## Doubts, answered when you initialled", ...doubtLines] : []),
      ].join("\n");
      const res = await api.createFeature({
        title: proposal.proposal.title,
        briefMd,
        ...(effectiveRepo ? { repoId: effectiveRepo } : {}),
        increments: steps.map((s) => ({ title: s.title, declaredSurface: s.surface, acceptanceMd: acceptanceOf(s) })),
        asked: { goal, at: askedAt ?? new Date().toISOString() },
        proposal: { at: proposedAt ?? new Date().toISOString(), filesSurveyed: proposal.filesSurveyed, note: questions?.lead ?? null },
      });
      const thread = await api.thread(res.featureId);
      const first = thread.steps[0];
      if (first) await api.approve(first.id);
      return res.featureId;
    },
    onSuccess: (featureId) => {
      navigate({ view: "thread", featureId });
      void qc.invalidateQueries();
    },
    onError: (e) => setError((e as Error).message),
  });

  const warnings = (proposal?.surfaceWarnings ?? []).filter((w) => !dismissed.includes(w.pattern) && steps.some((s) => s.surface.includes(w.pattern)));
  const doubtCount = steps.reduce((n, s) => n + s.doubts.length, 0);

  const onSend = (text: string) => {
    if (phase === "compose") void start(text);
    else if (phase === "reading" || phase === "questions") setMessages((m) => [...m, text]);
    else if (phase === "proposal") {
      setMessages((m) => [...m, text]);
      setTimeout(() => propose.mutate(answers()), 0);
    }
  };

  return (
    <Shell place="desk" title="Ask" crumb="Desk" onCrumb={() => navigate({ view: "desk" })}>
      <div className="convo">
        <div style={{ display: "flex", flexDirection: "column", gap: 16, overflow: "auto", minHeight: 0 }}>
          {messages.length > 0 && (
            <div className="msg you">
              <span className="who">{desk.data?.identity.initials ?? ""}</span>
              <div className="txt">
                {messages.map((m, i) => (
                  <p key={i}>{m}</p>
                ))}
              </div>
            </div>
          )}

          {phase === "reading" && (
            <div className="msg sig">
              <span className="who">S</span>
              <div className="txt">
                <p>
                  Reading <span className="mono">{repo?.label ?? "your repo"}</span> before I suggest anything.
                </p>
                <div className="reading">
                  {survey && (
                    <span>
                      <b>{survey.filesSurveyed} files</b> · on {survey.branch}
                    </span>
                  )}
                  {survey?.findings.map((f) => (
                    <span key={f.path}>
                      <b>{f.path}</b> · {f.note}
                    </span>
                  ))}
                  <span style={{ color: "var(--fg-2)" }}>{survey ? "working out what to ask…" : "reading the files…"}</span>
                </div>
              </div>
            </div>
          )}

          {phase === "questions" && questions && (
            <div className="msg sig">
              <span className="who">S</span>
              <div className="txt">
                <p>
                  <Inline text={questions.lead} /> {questions.questions.length === 1 ? "One thing" : `${words(questions.questions.length)[0]?.toUpperCase()}${words(questions.questions.length).slice(1)} things`} I would otherwise have to guess:
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
                  {questions.questions.map((q, i) => (
                    <div key={i}>
                      <div style={{ color: "var(--fg-1)" }}>
                        <Inline text={q.question} />
                      </div>
                      <div className="choice-row">
                        {q.options.map((o, j) => (
                          <button key={o} type="button" className={`choice ${(picks[i] ?? q.suggested) === j ? "on" : ""}`} onClick={() => setPicks((p) => p.map((x, k) => (k === i ? j : x)))}>
                            <Inline text={o} />
                          </button>
                        ))}
                        {q.note && <span style={{ color: "var(--fg-3)", fontSize: 12, alignSelf: "center" }}>{q.note}</span>}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                  <button type="button" className="btn btn-primary" onClick={() => propose.mutate(answers())}>
                    Propose with these
                  </button>
                  <button type="button" className="btn btn-outline" onClick={() => propose.mutate([])}>
                    Skip · let it guess
                  </button>
                </div>
              </div>
            </div>
          )}

          {phase === "proposing" && (
            <div className="msg sig">
              <span className="who">S</span>
              <div className="txt">
                <p>Working out the steps.</p>
                <div className="reading">
                  <span style={{ color: "var(--fg-2)" }}>writing the proposal…</span>
                </div>
              </div>
            </div>
          )}

          {phase === "proposal" && proposal && (
            <div className="msg sig">
              <span className="who">S</span>
              <div className="txt" style={{ width: "100%" }}>
                {!reshaping && (
                  <p>
                    {steps.length === 1 ? "One step, small enough to review on its own." : `${words(steps.length)[0]?.toUpperCase()}${words(steps.length).slice(1)} steps, each small enough to review on its own.`}
                    {doubtCount > 0 && ` ${doubtCount === 1 ? "One thing I am still unsure of is" : `${words(doubtCount)[0]?.toUpperCase()}${words(doubtCount).slice(1)} things I am still unsure of are`} pinned to ${doubtCount === 1 ? "its step" : "their steps"}.`}
                  </p>
                )}
                <Proposal
                  title={proposal.proposal.title}
                  steps={steps}
                  setSteps={setSteps}
                  reshaping={reshaping}
                  originalCount={originalCount}
                  warnings={warnings}
                  onDismiss={(p) => setDismissed((d) => [...d, p])}
                  perStep={estimate.data?.usd ?? null}
                />
                {reshaping ? (
                  <div style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "center", fontSize: 12, color: "var(--fg-3)" }}>
                    <span>Drag a file between fences · drag a step to reorder · cut between promises to split a step</span>
                    <button type="button" className="btn btn-outline" style={{ marginLeft: "auto" }} onClick={() => setReshaping(false)}>
                      Done reshaping
                    </button>
                  </div>
                ) : (
                  <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
                    <button type="button" className="btn btn-primary" disabled={create.isPending || steps.length === 0} onClick={() => create.mutate()}>
                      <Icon.pen />
                      Initial the plan
                    </button>
                    <button type="button" className="btn btn-outline" onClick={() => setReshaping(true)}>
                      Reshape
                    </button>
                    <button type="button" className="btn btn-outline" onClick={() => propose.mutate(answers())}>
                      Ask again
                    </button>
                    <span style={{ color: "var(--fg-3)", fontSize: 12, marginLeft: 8 }}>
                      {warnings.length > 0
                        ? `You can initial anyway. ${warnings.length === 1 ? "One fence looks" : `${words(warnings.length)[0]?.toUpperCase()}${words(warnings.length).slice(1)} fences look`} wrong.`
                        : "Initialling starts step 1. Nothing has been spent."}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
          {proposal?.proposal.noWorkNeeded && phase === "proposal" && steps.length === 0 && (
            <div className="msg sig">
              <span className="who">S</span>
              <div className="txt">
                <p>{proposal.proposal.noWorkNeeded}</p>
              </div>
            </div>
          )}
          {error && (
            <div className="msg sig">
              <span className="who">S</span>
              <div className="txt">
                <p className="seal">That did not work: {error}</p>
              </div>
            </div>
          )}
        </div>
        <Composer
          phase={phase}
          repoId={effectiveRepo}
          repoLabel={repo?.label ?? ""}
          branch={survey?.branch ?? "main"}
          repos={(repos.data?.repos ?? []).filter((r) => r.canMerge)}
          onRepo={setRepoId}
          onSend={onSend}
        />
      </div>
    </Shell>
  );
}

// ── the proposal card ──

function Proposal({
  title,
  steps,
  setSteps,
  reshaping,
  originalCount,
  warnings,
  onDismiss,
  perStep,
}: {
  title: string;
  steps: DraftStep[];
  setSteps: (s: DraftStep[]) => void;
  reshaping: boolean;
  originalCount: number;
  warnings: SurfaceWarning[];
  onDismiss: (pattern: string) => void;
  perStep: number | null;
}): ReactNode {
  const [drag, setDrag] = useState<{ kind: "file"; from: number; file: string } | { kind: "step"; from: number } | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const warningFor = (p: string) => warnings.find((w) => w.pattern === p);
  return (
    <div className="proposal">
      <div className="ph2">
        <b>{title}</b>
        <span className="crumb">
          {reshaping
            ? `reshaping · ${originalCount} ${originalCount === 1 ? "step" : "steps"} → ${steps.length}`
            : `${steps.length} ${steps.length === 1 ? "step" : "steps"}${perStep !== null ? ` · about ${money(perStep * steps.length)}` : ""}`}
        </span>
      </div>
      {steps.map((s, i) => {
        const bad = s.surface.map(warningFor).filter((w): w is SurfaceWarning => Boolean(w));
        const nothing = bad.find((w) => w.reason === "matches_nothing");
        const everything = bad.find((w) => w.reason === "matches_everything");
        return (
          <div
            key={i}
            className="pstep"
            // The whole step takes a drop: a file lands in its fence, a step lands before it.
            // The fence alone is one line tall, which is a small target for a hand.
            onDragOver={(e) => {
              if (drag?.kind === "step" || (drag?.kind === "file" && drag.from !== i)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOver(i);
              }
            }}
            onDrop={(e) => {
              if (!drag) return;
              e.preventDefault();
              setSteps(drag.kind === "step" ? moveStep(steps, drag.from, i) : moveFile(steps, drag.from, i, drag.file));
              setDrag(null);
              setOver(null);
            }}
            style={drag?.kind === "step" && over === i && drag.from !== i ? { boxShadow: "inset 0 2px 0 var(--fg-1)" } : undefined}
          >
            {reshaping ? (
              <span
                className="grip"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", s.title);
                  setDrag({ kind: "step", from: i });
                }}
                onDragEnd={() => (setDrag(null), setOver(null))}
                style={{ cursor: "grab" }}
                aria-label={`Drag step ${i + 1} to reorder`}
              >
                <Icon.grip />
              </span>
            ) : (
              <span className="ix">{i + 1}</span>
            )}
            <div>
              {reshaping ? (
                <input
                  className="t"
                  value={s.title}
                  onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                  style={{ background: "transparent", border: 0, color: "var(--fg-1)", font: "inherit", fontSize: 14, fontWeight: 500, width: "100%", padding: 0, outline: "none" }}
                />
              ) : (
                <div className="t">{s.title}</div>
              )}
              {!reshaping && <div className="r">{s.rationale}</div>}
              <div
                className={`fence ${drag?.kind === "file" && drag.from !== i && over === i ? "drop" : ""}`}
                style={{ marginTop: reshaping ? 8 : 0 }}
              >
                <span className="fl">may change</span>
                {s.surface.map((p) => (
                  <span
                    key={p}
                    className={`path ${warningFor(p) ? "bad" : ""} ${drag?.kind === "file" && drag.from === i && drag.file === p ? "ghost" : ""}`}
                    draggable={reshaping}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", p);
                      setDrag({ kind: "file", from: i, file: p });
                    }}
                    onDragEnd={() => (setDrag(null), setOver(null))}
                    style={reshaping ? { cursor: "grab" } : undefined}
                  >
                    {p}
                  </span>
                ))}
              </div>
              {!reshaping && nothing && (
                <div className="now yours" style={{ marginTop: 8, padding: "8px 12px" }}>
                  <div style={{ fontSize: 13, lineHeight: 1.55 }}>
                    <b className="seal">No file matches {nothing.pattern}.</b> The step would stop the moment it started.
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {nothing.suggestion && (
                      <button type="button" className="btn btn-secondary" onClick={() => setSteps(replaceFile(steps, nothing.pattern, nothing.suggestion as string))}>
                        Use {nothing.suggestion} instead
                      </button>
                    )}
                    <button type="button" className="btn btn-outline" onClick={() => onDismiss(nothing.pattern)}>
                      Keep it, I know better
                    </button>
                  </div>
                </div>
              )}
              {!reshaping && everything && (
                <div style={{ marginTop: 6, fontSize: 12 }} className="seal">
                  This fence encloses the whole repo, which is the same as having no fence.
                </div>
              )}
              {reshaping ? (
                s.promises.map((p, k) => (
                  <div key={k}>
                    {k > 0 && (
                      <button type="button" className="split" onClick={() => setSteps(splitStep(steps, i, k))} style={{ width: "100%", border: 0, background: "transparent", cursor: "pointer", font: "inherit", fontSize: 11 }}>
                        <Icon.scissors /> split here — the rest becomes its own step
                      </button>
                    )}
                    <div className="done-when" style={k > 0 ? { marginTop: 0 } : undefined}>
                      <Inline text={p} />
                    </div>
                  </div>
                ))
              ) : (
                <div className="done-when">
                  <b>
                    <Inline text={s.promises.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(" ")} />
                  </b>
                </div>
              )}
              {!reshaping &&
                s.doubts.map((d, k) => (
                  <div key={k} className="doubt">
                    <span className="qm">?</span>
                    <div>
                      <Inline text={d.question} />
                      {d.options.length > 0 && (
                        <div className="choice-row">
                          {d.options.map((o, j) => (
                            <button
                              key={o}
                              type="button"
                              className={`choice ${s.picks[k] === j ? "on" : ""}`}
                              onClick={() => setSteps(steps.map((x, xi) => (xi === i ? { ...x, picks: x.picks.map((pk, pi) => (pi === k ? j : pk)) } : x)))}
                            >
                              <Inline text={o} />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── the composer ──

function Composer({
  phase,
  repoId,
  repoLabel,
  branch,
  repos,
  onRepo,
  onSend,
}: {
  phase: Phase;
  repoId: string | undefined;
  repoLabel: string;
  branch: string;
  repos: Array<{ id: string; label: string }>;
  onRepo: (id: string) => void;
  onSend: (text: string) => void;
}): ReactNode {
  const [text, setText] = useState(() => {
    // A good first ask, carried over from the first-run page.
    try {
      const draft = sessionStorage.getItem("signet.askDraft");
      sessionStorage.removeItem("signet.askDraft");
      return draft ?? "";
    } catch {
      return "";
    }
  });
  const [picking, setPicking] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const files = useQuery({ queryKey: ["repo-files", repoId], queryFn: () => api.repoFiles(repoId), staleTime: 60_000 });

  // @ to point at a file: the word being typed after the last @.
  const at = /(?:^|\s)@([^\s@]*)$/.exec(text);
  const matches = useMemo(() => {
    if (!at) return [];
    const q = (at[1] ?? "").toLowerCase();
    return (files.data ?? []).filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
  }, [at, files.data]);
  useEffect(() => setSel(0), [matches.length]);

  const busy = phase === "proposing";
  const placeholder =
    phase === "compose"
      ? "Describe what you want built… type @ to point at a file"
      : phase === "proposal"
        ? "Add detail and it proposes again… type @ to point at a file"
        : "Add detail while it reads… type @ to point at a file";

  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    if (phase === "compose" && t.length < 20) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="composer" style={{ position: "relative" }}>
      {matches.length > 0 && (
        <div className="cmdk" style={{ position: "absolute", left: 0, right: 0, top: "auto", bottom: "100%", transform: "none", width: "auto", marginBottom: 8 }}>
          {matches.map((f, i) => (
            <button
              key={f}
              type="button"
              className={`it ${i === sel ? "on" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setText(text.replace(/@[^\s@]*$/, `@${f} `));
                ref.current?.focus();
              }}
            >
              <Icon.file />
              <span className="mono">{f}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className="ph"
        value={text}
        rows={phase === "compose" ? 3 : 1}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (matches.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setSel((s) => (e.key === "ArrowDown" ? Math.min(matches.length - 1, s + 1) : Math.max(0, s - 1)));
          } else if (matches.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
            e.preventDefault();
            setText(text.replace(/@[^\s@]*$/, `@${matches[sel]} `));
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        style={{ background: "transparent", border: 0, color: "var(--fg-1)", font: "inherit", fontSize: 14, resize: "none", outline: "none", width: "100%" }}
        autoFocus
      />
      <div className="row2">
        <Icon.git />
        <button type="button" className="mono" onClick={() => phase === "compose" && setPicking((v) => !v)} style={{ border: 0, background: "transparent", color: "inherit", padding: 0, cursor: phase === "compose" ? "pointer" : "default" }}>
          {repoLabel}
        </button>
        <span>·</span>
        <span>{branch}</span>
        <span style={{ marginLeft: "auto" }}>nothing is created until you initial it</span>
      </div>
      {picking && (
        <div className="cmdk" style={{ position: "absolute", left: 0, right: 0, top: "auto", bottom: "100%", transform: "none", width: "auto", marginBottom: 8, maxHeight: 320, overflow: "auto" }}>
          <div className="grp">Which repo</div>
          {repos.map((r) => (
            <button key={r.id} type="button" className={`it ${r.id === repoId ? "on" : ""}`} onClick={() => (onRepo(r.id), setPicking(false))}>
              <Icon.folder />
              <span className="mono">{r.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
