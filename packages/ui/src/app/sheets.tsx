// The signing sheets. A signature deserves a document: each clause is one thing you
// are agreeing to, and the gesture matches the weight of the decision — initials are one
// click, because nothing has been spent; the seal is pressed and held, because it lands
// work on main.
//
// The sheet slides over the thread, so what you asked for stays visible behind it.

import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LineNote, PromiseProof, StepSheet } from "@signet/contracts";
import { api } from "../api.js";
import { Icon, Tick } from "./icons.js";
import { navigate, type Sheet } from "./router.js";
import { clock, money, words } from "./format.js";
import { SealButton, SealMark, rimText } from "./seal.js";
import { EventRow } from "./thread.js";
import { patchRows } from "./patch.js";

const CHECK_NAME: Record<string, string> = {
  typecheck: "Types",
  lint: "Lint",
  tests: "Tests",
  conformance: "Design",
  rules: "Conventions",
};

/** "Types · Lint · Tests passed. Design has nothing to compare against. Conventions passed." */
export function checksSentence(checks: StepSheet["checks"]): string {
  const core = checks.filter((c) => ["typecheck", "lint", "tests"].includes(c.gate));
  const passed = core.filter((c) => c.outcome === "pass").map((c) => CHECK_NAME[c.gate]);
  const skipped = core.filter((c) => c.outcome === "skipped").map((c) => CHECK_NAME[c.gate]);
  const parts: string[] = [];
  if (passed.length > 0) parts.push(`${passed.join(" · ")} passed.`);
  if (skipped.length > 0) parts.push(`${skipped.join(" and ")} had nothing to check.`);
  const design = checks.find((c) => c.gate === "conformance");
  if (design) parts.push(design.outcome === "skipped" ? "Design has nothing to compare against." : `Design ${design.outcome === "pass" ? "matched" : design.outcome}.`);
  const rules = checks.find((c) => c.gate === "rules");
  if (rules) parts.push(rules.outcome === "pass" ? "Conventions passed." : rules.outcome === "skipped" ? "No conventions accepted yet." : "Conventions warned.");
  return parts.join(" ");
}

function promiseText(acceptance: string): string {
  return acceptance
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").trim())
    .filter(Boolean)
    .map((l) => (/[.!?]$/.test(l) ? l : `${l}.`))
    .join(" ");
}

export function StepSheetOverlay({
  featureId,
  sheet,
  from,
  onClose,
}: {
  featureId: string;
  sheet: Sheet;
  from?: "desk" | "flow" | undefined;
  onClose: () => void;
}): ReactNode {
  const s = useQuery({ queryKey: ["sheet", sheet.step], queryFn: () => api.sheet(sheet.step), refetchInterval: 5000 });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!s.data) return null;
  const d = s.data;
  const body =
    sheet.kind === "initial" && d.status === "CONTEXT_READY" ? (
      <InitialSheet d={d} onDone={onClose} />
    ) : d.status === "MERGED" ? (
      <SealedSheet d={d} />
    ) : d.status === "AWAITING_SIGNATURE" ? (
      <SealSheet d={d} tab={sheet.tab ?? "promises"} setTab={(tab) => navigate({ view: "thread", featureId, from, sheet: { ...sheet, tab } })} />
    ) : (
      <GoneSheet d={d} />
    );
  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet-doc" style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>
  );
}

/** The step moved on while the sheet was opening: say so rather than offer a stale action. */
function GoneSheet({ d }: { d: StepSheet }): ReactNode {
  return (
    <>
      <div className="sd-head">
        <div className="eyebrow2" style={{ color: "var(--fg-3)" }}>
          Nothing to sign
        </div>
        <h2>{d.title}</h2>
        <div className="sub2">This step is {d.status.toLowerCase().replace(/_/g, " ")} now.</div>
      </div>
    </>
  );
}

// ── initials ──

function InitialSheet({ d, onDone }: { d: StepSheet; onDone: () => void }): ReactNode {
  const qc = useQueryClient();
  const [signed, setSigned] = useState(false);
  const approve = useMutation({
    mutationFn: () => api.approve(d.incrementId),
    onSuccess: async () => {
      setSigned(true);
      await qc.invalidateQueries();
      setTimeout(onDone, 700);
    },
  });
  return (
    <>
      <div className="sd-head">
        <div className="eyebrow2">Initial · the plan</div>
        <h2>Build “{d.title}”</h2>
        <div className="sub2">
          Step {d.stepIndex} of {d.stepCount} · {d.featureTitle} · {d.repoLabel}
        </div>
      </div>
      <div className="sd-body">
        <div className="clause">
          <div className="ck">You agree to</div>
          <div className="cv">Signet writing this step in its own copy of the repo, on its own branch, using your Claude subscription.</div>
        </div>
        <div className="clause">
          <div className="ck">It may change</div>
          <div className="cv">
            <div className="fence">
              {d.surface.map((p) => (
                <span key={p} className="path">
                  {p}
                </span>
              ))}
            </div>
            <div style={{ color: "var(--fg-3)", fontSize: 12, marginTop: 4 }}>If it needs anything else, it stops and asks.</div>
          </div>
        </div>
        <div className="clause">
          <div className="ck">Done when</div>
          <div className="cv">
            {promiseText(d.acceptance) || (
              <span style={{ color: "var(--fg-3)" }}>Not written down — this step was made before steps said what done means. It will be judged by the checks alone.</span>
            )}
          </div>
        </div>
        <div className="clause">
          <div className="ck">It will not</div>
          <div className="cv">Merge anything. Push anything. Touch your checkout. You seal it before any of it reaches {d.base}.</div>
        </div>
        <div className="clause">
          <div className="ck">Likely cost</div>
          <div className="cv">
            {d.likelyUsd !== null
              ? `About ${money(d.likelyUsd)}, from the last ${d.likelySample} ${d.likelySample === 1 ? "step" : "steps"} built here. Nothing spent yet.`
              : "No steps have been built here yet, so there is nothing to estimate from. Nothing spent yet."}
          </div>
        </div>
      </div>
      <div className="sd-foot">
        <div className="sigline">
          <span className="init-box">
            <span className="initials" style={{ color: signed ? "var(--fg-1)" : "var(--fg-3)" }}>
              {d.identity.initials}
            </span>
          </span>
          <span style={{ flex: 1, color: "var(--fg-3)", fontSize: 12 }}>
            {signed ? `Initialled ${clock(new Date())}` : "Initials go here when you click"}
          </span>
          <button type="button" className="btn btn-primary" disabled={approve.isPending || signed} onClick={() => approve.mutate()}>
            <Icon.pen />
            Initial the plan
          </button>
        </div>
        <div style={{ color: approve.error ? "var(--seal)" : "var(--fg-3)", fontSize: 12 }}>
          {approve.error ? `That did not go through: ${(approve.error as Error).message}` : "One click. Initials approve spending, not code — the seal comes later."}
        </div>
      </div>
    </>
  );
}

// ── the seal ──

/** True at phone width, where the seal sheet takes the phone layout. */
function useNarrow(): boolean {
  const q = "(max-width: 640px)";
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== "undefined" && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const m = matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

function SealSheet(props: { d: StepSheet; tab: "promises" | "change" | "story"; setTab: (t: "promises" | "change" | "story") => void }): ReactNode {
  const narrow = useNarrow();
  return narrow && props.tab === "promises" ? <PhoneSeal {...props} /> : <DeskSeal {...props} />;
}

/**
 * The seal on a phone: the promises and their proof first, the seal under your thumb.
 * A diff is unreadable on a phone; a list of proven promises is not.
 */
function PhoneSeal({ d, setTab }: { d: StepSheet; tab: string; setTab: (t: "promises" | "change" | "story") => void }): ReactNode {
  const qc = useQueryClient();
  const promises = useQuery({ queryKey: ["promises", d.incrementId], queryFn: () => api.promises(d.incrementId) });
  const checkout = useQuery({ queryKey: ["checkout", d.incrementId], queryFn: () => api.checkout(d.incrementId), refetchInterval: 2000 });
  const desk = useQuery({ queryKey: ["desk"], queryFn: api.desk });
  const merge = useMutation({ mutationFn: () => api.merge(d.incrementId, { onTrust: false }), onSuccess: () => void qc.invalidateQueries() });
  const seals = (desk.data?.decisions ?? []).filter((x) => x.kind === "seal");
  const position = seals.findIndex((x) => x.incrementId === d.incrementId) + 1;
  const all = promises.data?.promises ?? [];
  const checked = promises.data?.checked ?? false;
  const unproven = checked ? all.filter((p) => !p.proven) : [];
  const offBranch = checkout.data && !checkout.data.onBase;
  const off = Boolean(offBranch) || unproven.length > 0;
  return (
    <div className="phone-seal">
      <div style={{ fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--seal)" }}>
        Seal{position > 0 ? ` · ${position} of ${seals.length}` : ""}
      </div>
      <div style={{ fontFamily: "var(--sign)", fontSize: 26, lineHeight: 1.15 }}>Seal “{d.title}”</div>
      <div style={{ fontSize: 12, color: "var(--fg-2)" }}>
        {[d.files !== null ? `${d.files} ${d.files === 1 ? "file" : "files"} · +${d.added ?? 0} −${d.removed ?? 0}` : null, d.builtAt ? `built ${clock(d.builtAt)}` : null].filter(Boolean).join(" · ")}
      </div>
      {all.length > 0 && (
      <div className="crit">
        {all.map((p, i) => (
          <div key={i} className={`crit-row ${checked && !p.proven ? "missing" : ""}`}>
            <Tick gap={checked && !p.proven} />
            <div className="claim">{p.promise}</div>
          </div>
        ))}
      </div>
      )}
      <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
        {offBranch ? `Your checkout is on ${checkout.data?.branch} — switch to ${d.base} to seal.` : unproven.length > 0 ? "One promise has no test. Open it on your desk to ask for one or seal on trust." : `Lands on ${d.base} · not pushed · can be taken back`}
      </div>
      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
        <SealButton initials={d.identity.initials} off={off || merge.isPending} onSeal={() => merge.mutate()} />
        <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Press and hold</div>
        <button type="button" className="btn btn-outline" style={{ alignSelf: "stretch" }} onClick={() => setTab("change")}>
          See the change
        </button>
      </div>
    </div>
  );
}

function DeskSeal({ d, tab, setTab }: { d: StepSheet; tab: "promises" | "change" | "story"; setTab: (t: "promises" | "change" | "story") => void }): ReactNode {
  const qc = useQueryClient();
  const promises = useQuery({ queryKey: ["promises", d.incrementId], queryFn: () => api.promises(d.incrementId) });
  // Watched while the sheet is open, so switching branch in a terminal unlocks the seal.
  const checkout = useQuery({ queryKey: ["checkout", d.incrementId], queryFn: () => api.checkout(d.incrementId), refetchInterval: 2000 });
  const [trust, setTrust] = useState(false);
  const [notes, setNotes] = useState<LineNote[]>([]);
  const merge = useMutation({
    mutationFn: () => api.merge(d.incrementId, { onTrust: trust }),
    onSuccess: () => void qc.invalidateQueries(),
  });
  const sendBack = useMutation({
    mutationFn: (n: LineNote[]) => api.sendBack(d.incrementId, n),
    onSuccess: () => void qc.invalidateQueries(),
  });

  // C starts a note on the change.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.key === "c" && !e.metaKey && !e.ctrlKey) setTab("change");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTab]);

  const all = promises.data?.promises ?? [];
  const checked = promises.data?.checked ?? false;
  const unproven = checked ? all.filter((p) => !p.proven) : [];
  const proven = all.length - unproven.length;
  const offBranch = checkout.data && !checkout.data.onBase ? checkout.data : null;
  const off = offBranch !== null || (unproven.length > 0 && !trust);

  const sub = [
    d.files !== null ? `${d.files} ${d.files === 1 ? "file" : "files"} · +${d.added ?? 0} −${d.removed ?? 0}` : null,
    offBranch ? `${proven} of ${all.length} promises proven` : null,
    !offBranch && d.builtAt ? `built ${clock(d.builtAt)}` : null,
    !offBranch && d.repairs > 0 ? (d.repairs === 1 ? "one repair" : `${words(d.repairs)} repairs`) : null,
    !offBranch && unproven.length > 0 && d.repairs === 0 ? "every check passed" : null,
    !offBranch && d.spentUsd ? money(d.spentUsd) : null,
    offBranch ? "every check passed" : null,
  ].filter(Boolean);

  return (
    <>
      <div className="sd-head">
        <div className="eyebrow2">Seal · the work</div>
        <h2>Seal “{d.title}”</h2>
        <div className="sub2">{sub.join(" · ")}</div>
      </div>
      <div className="sd-body" style={{ overflow: "auto" }}>
        {offBranch && (
          <div className="now yours" style={{ marginTop: 0 }}>
            <div style={{ fontSize: 14 }}>
              <b>
                Your checkout is on <span className="mono">{offBranch.branch}</span>, not <span className="mono">{offBranch.base}</span>.
              </b>
            </div>
            <div style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.6 }}>
              Sealing now would land this on {offBranch.branch}. Switch back and the seal unlocks by itself — Signet will not move your checkout for you.
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="path">git switch {offBranch.base}</span>
              <CopyButton text={`git switch ${offBranch.base}`} />
              <span style={{ color: "var(--fg-3)", fontSize: 12, marginLeft: "auto" }}>watching for the switch…</span>
            </div>
          </div>
        )}
        {!offBranch && (
          <div className="stabs">
            {(
              [
                ["promises", all.length === 0 ? "Promises · none" : `Promises · ${checked ? `${proven} of ${all.length} proven` : `${all.length} to prove`}`],
                ["change", `The change · ${d.files ?? 0} ${d.files === 1 ? "file" : "files"}`],
                ["story", "How it got here"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" className={tab === k ? "on" : ""} onClick={() => setTab(k)} style={{ border: 0, background: "transparent", font: "inherit", cursor: "pointer", padding: "0 0 8px" }}>
                {label}
              </button>
            ))}
          </div>
        )}

        {(offBranch || tab === "promises") && (
          <>
            <Promises all={all} checked={checked} short={offBranch !== null} />
            {!offBranch && unproven.length > 0 && (
              <div className="now yours" style={{ marginTop: 0 }}>
                <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                  <b>
                    Every check passed, and {unproven.length === 1 ? "one thing" : `${words(unproven.length)} things`} you agreed to{" "}
                    {unproven.length === 1 ? "is" : "are"} still unproven.
                  </b>{" "}
                  Checks only cover what was tested. Ask for the missing {unproven.length === 1 ? "test" : "tests"} — a small, targeted repair — or seal knowing{" "}
                  {unproven.length === 1 ? "this one is" : "these are"} taken on trust.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={sendBack.isPending}
                    onClick={() => sendBack.mutate(unproven.map((p) => ({ file: null, line: null, text: `Add a test that proves: ${p.promise}` })))}
                  >
                    <Icon.reply />
                    Ask for the missing {unproven.length === 1 ? "test" : "tests"}
                  </button>
                  <button type="button" className="btn btn-outline" onClick={() => setTrust((v) => !v)} style={trust ? { borderColor: "var(--seal)", color: "var(--seal)" } : undefined}>
                    {trust ? "Sealing on trust" : "Seal on trust"}
                  </button>
                </div>
              </div>
            )}
            {!offBranch && unproven.length === 0 && (
              <>
                {d.checks.length > 0 && (
                  <div className="clause">
                    <div className="ck">Checks</div>
                    <div className="cv" style={{ fontSize: 13, color: "var(--fg-2)" }}>
                      {checksSentence(d.checks)}
                    </div>
                  </div>
                )}
                <div className="clause">
                  <div className="ck">Lands on</div>
                  <div className="cv">
                    {d.base}, in {d.repoPath.replace(/^\/Users\/[^/]+/, "~")}, as one merge commit. Not pushed. You can take it back from the ledger.
                  </div>
                </div>
                <div className="clause">
                  <div className="ck">Built from</div>
                  <div className="cv" style={{ fontSize: 13, color: "var(--fg-2)" }}>
                    What you asked for, version {d.briefVersion}
                    {d.answers.length > 0 ? ` — including your ${d.answers.length === 1 ? "answer" : "answers"}: “${d.answers.map((a) => a.replace(/[.\s]+$/, "")).join("”, “")}”` : ""}.
                  </div>
                </div>
              </>
            )}
          </>
        )}
        {!offBranch && tab === "change" && <Change incrementId={d.incrementId} notes={notes} setNotes={setNotes} sending={sendBack.isPending} onSend={() => sendBack.mutate(notes)} />}
        {!offBranch && tab === "story" && <Story featureId={d.featureId} incrementId={d.incrementId} />}
        {(merge.error || sendBack.error) && (
          <div style={{ color: "var(--seal)", fontSize: 12 }}>That did not go through: {((merge.error ?? sendBack.error) as Error).message}</div>
        )}
      </div>
      <div className="sd-foot">
        <div className="sealpress">
          <SealButton initials={d.identity.initials} off={off || merge.isPending} onSeal={() => merge.mutate()} />
          {offBranch ? (
            <div style={{ color: "var(--fg-3)", fontSize: 12 }}>Unlocks when your checkout is on {offBranch.base}.</div>
          ) : off ? (
            <div style={{ color: "var(--fg-3)", fontSize: 12, lineHeight: 1.5 }}>
              The seal unlocks when every promise has proof,
              <br />
              or when you choose to seal one on trust.
            </div>
          ) : notes.length > 0 ? (
            <div style={{ color: "var(--fg-3)", fontSize: 12, lineHeight: 1.5 }}>Sealing now would drop your {notes.length === 1 ? "note" : "notes"}.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 15 }}>{trust ? "Press and hold to seal on trust" : "Press and hold the seal"}</div>
              <div style={{ color: "var(--fg-3)", fontSize: 12 }}>
                About a second · or hold <span className="kbd">↵</span> · the ring fills as you hold
              </div>
            </div>
          )}
          {!offBranch && !off && notes.length === 0 && (
            <button type="button" onClick={() => setTab("change")} style={{ marginLeft: "auto", color: "var(--fg-3)", fontSize: 12, border: 0, background: "transparent", cursor: "pointer" }}>
              Send back with a note <span className="kbd">C</span>
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function Promises({ all, checked, short }: { all: PromiseProof[]; checked: boolean; short: boolean }): ReactNode {
  if (all.length === 0) return null;
  return (
    <div className="crit">
      {all.map((p, i) => {
        const gap = checked && !p.proven;
        return (
          <div key={i} className={`crit-row ${gap ? "missing" : ""}`}>
            <Tick gap={gap} />
            <div className="claim">{p.promise}</div>
            <div className="proof">
              {gap ? (
                <>
                  <b>No test proves this.</b>
                  {p.reason && p.reason !== "No test proves this." && <span style={{ fontSize: 12 }}>{p.reason}</span>}
                </>
              ) : !checked ? (
                <span style={{ fontSize: 12 }}>not checked</span>
              ) : short ? (
                <span style={{ fontSize: 12 }}>proven</span>
              ) : p.bySuite ? (
                <>
                  <span className="mono" style={{ fontSize: 11.5 }}>
                    the whole suite
                  </span>
                  <span className="mono" style={{ fontSize: 11.5 }}>
                    run and passed by the tests check
                  </span>
                </>
              ) : (
                <>
                  <span className="mono" style={{ fontSize: 11.5 }}>
                    {p.changedTest ? "changed test" : p.existingTest ? "existing test" : "test"} · “{p.test}”
                  </span>
                  <span className="mono" style={{ fontSize: 11.5 }}>
                    {p.codeFile && p.codeLines ? `${p.codeFile}:${p.codeLines}` : p.testFile}
                  </span>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The change, where clicking a line starts a note on it. */
function Change({
  incrementId,
  notes,
  setNotes,
  sending,
  onSend,
}: {
  incrementId: string;
  notes: LineNote[];
  setNotes: (n: LineNote[]) => void;
  sending: boolean;
  onSend: () => void;
}): ReactNode {
  const diff = useQuery({ queryKey: ["diff", incrementId], queryFn: () => api.diff(incrementId) });
  const [draft, setDraft] = useState<{ file: string; line: number } | null>(null);
  const [text, setText] = useState("");
  if (!diff.data) return null;
  if (!diff.data.available) return <div style={{ color: "var(--fg-3)" }}>{diff.data.reason}</div>;
  const rows = patchRows(diff.data.patch);
  const byFile = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.file || r.kind === "meta") continue;
    byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  }
  const stat = new Map(diff.data.files.map((f) => [f.path, f]));
  const noteAt = (file: string, line: number) => notes.filter((n) => n.file === file && n.line === line);

  return (
    <>
      {[...byFile.entries()].map(([file, lines]) => (
        <div key={file} className="diff">
          <div className="dfile">
            <Icon.file />
            <span className="mono">{file}</span>
            <span style={{ marginLeft: "auto" }}>
              +{stat.get(file)?.added ?? 0} −{stat.get(file)?.removed ?? 0}
            </span>
          </div>
          {lines
            .filter((r) => r.kind !== "hunk")
            .map((r, i) => {
              const noted = r.line !== null && noteAt(file, r.line).length > 0;
              const drafting = draft?.file === file && draft.line === r.line;
              return (
                <div
                  key={i}
                  className={`dl ${r.kind === "add" ? "add" : r.kind === "del" ? "del" : ""} ${noted || drafting ? "sel" : ""}`}
                  onClick={() => r.line !== null && (setDraft({ file, line: r.line }), setText(""))}
                  style={{ cursor: r.line !== null ? "pointer" : "default" }}
                >
                  <span className="n">{r.line ?? ""}</span>
                  <span className="s">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
                  <span className="code">{r.text.slice(1)}</span>
                </div>
              );
            })}
        </div>
      ))}
      {draft && (
        <div className="mnote">
          <div className="by">
            YOUR NOTE · {draft.file.split("/").pop()?.toUpperCase()} · LINE {draft.line}
          </div>
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What should change here? Write it as you would in a code review."
            rows={2}
            style={{ background: "transparent", border: 0, color: "var(--fg-1)", font: "inherit", resize: "none", outline: "none" }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn btn-outline"
              disabled={!text.trim()}
              onClick={() => {
                setNotes([...notes, { file: draft.file, line: draft.line, text: text.trim() }]);
                setDraft(null);
              }}
            >
              Add note
            </button>
            <button type="button" className="btn btn-outline" onClick={() => setDraft(null)} style={{ border: 0 }}>
              cancel
            </button>
          </div>
        </div>
      )}
      {notes.map((n, i) => (
        <div key={i} className="mnote">
          <div className="by">
            YOUR NOTE · {n.file?.split("/").pop()?.toUpperCase()} · LINE {n.line}
          </div>
          <div>{n.text}</div>
          {i === notes.length - 1 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button type="button" className="btn btn-secondary" disabled={sending} onClick={onSend}>
                <Icon.reply />
                Send back with {notes.length} {notes.length === 1 ? "note" : "notes"}
              </button>
              <span style={{ color: "var(--fg-3)", fontSize: 12 }}>One repair, aimed at these lines. The promises stay as they are.</span>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function Story({ featureId, incrementId }: { featureId: string; incrementId: string }): ReactNode {
  const t = useQuery({ queryKey: ["thread", featureId], queryFn: () => api.thread(featureId) });
  const events = (t.data?.events ?? []).filter((e) => e.incrementId === incrementId || e.incrementId === null);
  return (
    <div className="thread">
      {events.map((e, i) => (
        <EventRow key={i} e={e} />
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }): ReactNode {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-outline"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setDone(true))
          .catch(() => setDone(false));
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

// ── sealed ──

function SealedSheet({ d }: { d: StepSheet }): ReactNode {
  const promises = useQuery({ queryKey: ["promises", d.incrementId], queryFn: () => api.promises(d.incrementId) });
  const desk = useQuery({ queryKey: ["desk"], queryFn: api.desk });
  const at = d.mergedAt ? new Date(d.mergedAt) : new Date();
  const nextDecision = desk.data?.decisions[0];
  const goNext = () => {
    if (!nextDecision) return navigate({ view: "desk" });
    const kind = nextDecision.kind === "seal" ? "seal" : nextDecision.kind === "initial" ? "initial" : null;
    navigate(kind ? { view: "thread", featureId: nextDecision.featureId, sheet: { kind, step: nextDecision.incrementId } } : { view: "thread", featureId: nextDecision.featureId });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Enter" && goNext();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const next =
    d.next === null
      ? `That was the last step of “${d.featureTitle}”.`
      : d.next.status === "CONTEXT_READY"
        ? `Step ${d.stepIndex + 1}, “${d.next.title}”, is waiting for your initials.`
        : d.next.status === "RUNNING" || d.next.status === "VERIFYING"
          ? `Step ${d.stepIndex + 1}, “${d.next.title}”, is already initialled and starts now. You will see it on your Desk when it is ready to seal.`
          : `Step ${d.stepIndex + 1}, “${d.next.title}”, is ${d.next.status.toLowerCase().replace(/_/g, " ")}.`;
  return (
    <>
      <div className="sd-head">
        <div className="eyebrow2">Sealed · {clock(at)}</div>
        <h2>Sealed “{d.title}”</h2>
        <div className="sub2">
          Landed on {d.base}
          {d.sha ? ` as ${d.sha.slice(0, 7)}` : ""} · not pushed
        </div>
      </div>
      <div className="sd-body">
        <Promises all={promises.data?.promises ?? []} checked={promises.data?.checked ?? false} short />
        <div className="clause">
          <div className="ck">What happens next</div>
          <div className="cv">{next}</div>
        </div>
        {/* Stamped after the record, over the empty end of the page — askew, as a real stamp lands. */}
        <div style={{ alignSelf: "flex-end", transform: "rotate(-9deg)", margin: "-8px 24px 8px 0", filter: "drop-shadow(0 8px 18px color-mix(in srgb, var(--ink-0) 70%, transparent))" }}>
          <SealMark size={168} initials={d.identity.initials} rim={rimText(at, d.sha)} trust={d.onTrust.length > 0} />
        </div>
      </div>
      <div className="sd-foot">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" className="btn btn-primary" onClick={goNext}>
            Next decision
          </button>
          <span className="kbd">↵</span>
          {d.takenBack ? (
            <span style={{ marginLeft: "auto", color: "var(--fg-3)", fontSize: 12 }}>Taken back — its revert is on {d.base}.</span>
          ) : (
            <button type="button" className="btn btn-outline" style={{ marginLeft: "auto" }} onClick={() => navigate({ view: "flow", tab: "ledger", open: d.incrementId })}>
              <Icon.undo />
              Take it back
            </button>
          )}
        </div>
        <div style={{ color: "var(--fg-3)", fontSize: 12 }}>The seal is kept in the ledger with the promises, the proof and the commit.</div>
      </div>
    </>
  );
}
