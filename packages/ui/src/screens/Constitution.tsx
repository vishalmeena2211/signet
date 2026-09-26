// Screen 4: the design constitution / confirmation queue. Mined rules arrive
// as proposals; the human accepts, edits, or rejects — with the actual
// evidence (file:line, asset paths, git trend) shown inline. This is where a
// rule earns the authority to gate.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RuleCard } from "@signet/contracts";
import { api } from "../api.js";
import { ErrorNote } from "../components.js";

const TREND_COLOR: Record<string, string> = {
  new: "var(--accent)",
  growing: "var(--ok)",
  stable: "var(--text-dim)",
  dying: "var(--warn)",
  gone: "var(--fail)",
  unknown: "var(--text-dim)",
};

const KIND_ICON: Record<string, string> = {
  color: "🎨",
  asset: "🖼️",
  token: "🔤",
  spacing: "📐",
  typography: "🔡",
};

export function Constitution({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const queue = useQuery({ queryKey: ["rules"], queryFn: () => api.ruleQueue(), refetchInterval: 4000 });
  const [repoPath, setRepoPath] = useState("");

  const learn = useMutation({
    mutationFn: () => api.learn(repoPath),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "var(--space-8) var(--space-4)" }}>
      <button onClick={onBack} style={{ marginBottom: "var(--space-4)" }}>
        ← board
      </button>
      <h1 style={{ fontSize: "var(--fs-xl)", margin: 0 }}>Design constitution</h1>
      <div style={{ color: "var(--text-dim)", marginTop: "var(--space-1)" }}>
        Rules mined from a codebase. A rule gates only after you confirm it — that's what earns it authority.
      </div>

      <div
        style={{
          display: "flex",
          gap: "var(--space-2)",
          marginTop: "var(--space-6)",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "var(--space-3)",
        }}
      >
        <input
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder="Absolute path to a repo to learn, e.g. /Users/you/Desktop/DIGISTAY/guest-frontend"
          style={{
            flex: 1,
            background: "var(--surface-raised)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text)",
            padding: "var(--space-2) var(--space-3)",
            font: "inherit",
          }}
        />
        <button className="primary" disabled={!repoPath.trim() || learn.isPending} onClick={() => learn.mutate()}>
          {learn.isPending ? "Learning…" : "Learn this repo"}
        </button>
      </div>
      {learn.data && (
        <div style={{ color: "var(--ok)", marginTop: "var(--space-2)" }}>
          Learned {learn.data.label}: {learn.data.proposed} new proposals ({learn.data.skipped} already known).
        </div>
      )}
      <div style={{ marginTop: "var(--space-2)" }}>
        <ErrorNote error={learn.error} onDismiss={() => learn.reset()} />
        <ErrorNote error={queue.error} />
      </div>

      <div style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-6)" }}>
        {queue.data?.length === 0 && (
          <div style={{ color: "var(--text-dim)", padding: "var(--space-6)", textAlign: "center" }}>
            Queue empty. Learn a repo above to propose rules.
          </div>
        )}
        {queue.data?.map((r) => (
          <RuleCardView key={r.id} rule={r} onDone={() => qc.invalidateQueries({ queryKey: ["rules"] })} />
        ))}
      </div>
    </div>
  );
}

function RuleCardView({ rule, onDone }: { rule: RuleCard; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.statement);
  const confirm = useMutation({ mutationFn: () => api.confirmRule(rule.id), onSuccess: onDone });
  const reject = useMutation({ mutationFn: () => api.rejectRule(rule.id), onSuccess: onDone });
  const save = useMutation({ mutationFn: () => api.editRule(rule.id, text), onSuccess: () => { setEditing(false); onDone(); } });
  const busy = confirm.isPending || reject.isPending || save.isPending;

  return (
    <div
      style={{
        background: "var(--surface)",
        border: `1px solid ${rule.status === "DEMOTED" ? "var(--warn)" : "var(--border)"}`,
        borderRadius: "var(--radius)",
        padding: "var(--space-4)",
        display: "grid",
        gap: "var(--space-3)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)", alignItems: "flex-start" }}>
        {editing ? (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{
              flex: 1,
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text)",
              padding: "var(--space-2)",
              font: "inherit",
              minHeight: 56,
            }}
          />
        ) : (
          <div style={{ fontSize: "var(--fs-lg)" }}>
            {KIND_ICON[rule.kind] ?? "•"} {rule.statement}
          </div>
        )}
        <div style={{ display: "flex", gap: "var(--space-2)", whiteSpace: "nowrap", fontSize: "var(--fs-sm)" }}>
          <span style={{ color: TREND_COLOR[rule.trend] }}>{rule.trend}</span>
          <span style={{ color: "var(--text-dim)" }}>{Math.round(rule.confidence * 100)}%</span>
        </div>
      </div>

      {rule.status === "DEMOTED" && (
        <div style={{ color: "var(--warn)", fontSize: "var(--fs-sm)" }}>
          auto-demoted after {rule.fpCount} false positives — re-confirm only if still correct
        </div>
      )}

      <details>
        <summary style={{ cursor: "pointer", color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>
          {rule.evidence.length} evidence item{rule.evidence.length === 1 ? "" : "s"}
        </summary>
        <div style={{ display: "grid", gap: "var(--space-1)", marginTop: "var(--space-2)" }}>
          {rule.evidence.map((e, i) => (
            <code key={i} style={{ color: "var(--text-dim)" }}>
              [{e.kind}] {e.ref}
              {e.detail ? ` — ${e.detail}` : ""}
            </code>
          ))}
        </div>
      </details>

      <ErrorNote
        error={confirm.error ?? reject.error ?? save.error}
        onDismiss={() => {
          confirm.reset();
          reject.reset();
          save.reset();
        }}
      />

      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        {editing ? (
          <>
            <button className="primary" disabled={busy} onClick={() => save.mutate()}>
              Save & confirm
            </button>
            <button disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button className="primary" disabled={busy} onClick={() => confirm.mutate()}>
              Confirm
            </button>
            <button disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button disabled={busy} onClick={() => reject.mutate()} style={{ color: "var(--fail)" }}>
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}
