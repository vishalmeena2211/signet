// Screen 2: feature detail — the pipeline rail. Per increment: state, the two
// signature actions, per-gate verdicts with per-dimension findings (top
// findings only; the server already bounds them).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GateVerdictView, IncrementDetail } from "@signet/contracts";
import { api } from "../api.js";

const STATE_COLOR: Record<string, string> = {
  PLANNED: "var(--text-dim)",
  CONTEXT_READY: "var(--accent)",
  RUNNING: "var(--running)",
  VERIFYING: "var(--running)",
  AWAITING_SIGNATURE: "var(--warn)",
  MERGED: "var(--ok)",
  ESCALATED: "var(--warn)",
  PARKED: "var(--text-dim)",
  FAILED: "var(--fail)",
};

const STATE_LABEL: Record<string, string> = {
  PLANNED: "planned",
  CONTEXT_READY: "ready — approve to start",
  RUNNING: "agent working…",
  VERIFYING: "gates running…",
  AWAITING_SIGNATURE: "passed all gates — review & merge",
  MERGED: "merged",
  ESCALATED: "question raised — needs your answer",
  PARKED: "parked (quota) — resumes automatically",
  FAILED: "failed",
};

export function Detail({ featureId, onBack }: { featureId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ["feature", featureId],
    queryFn: () => api.feature(featureId),
    refetchInterval: 3000,
  });
  const approve = useMutation({
    mutationFn: api.approve,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["feature", featureId] }),
  });
  const merge = useMutation({
    mutationFn: api.merge,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["feature", featureId] }),
  });

  if (!detail.data) return <div style={{ padding: "var(--space-8)" }}>Loading…</div>;
  const { feature, increments, verdicts } = detail.data;

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-8) var(--space-4)" }}>
      <button onClick={onBack} style={{ marginBottom: "var(--space-4)" }}>
        ← board
      </button>
      <h1 style={{ fontSize: "var(--fs-xl)", margin: 0 }}>{feature.title}</h1>
      <div style={{ color: "var(--text-dim)", marginTop: "var(--space-1)" }}>
        {feature.incrementsMerged}/{feature.incrementsTotal} merged
      </div>

      <div style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-6)" }}>
        {increments.map((inc) => (
          <IncrementCard
            key={inc.id}
            inc={inc}
            verdicts={verdicts[inc.id] ?? []}
            onApprove={() => approve.mutate(inc.id)}
            onMerge={() => merge.mutate(inc.id)}
            busy={approve.isPending || merge.isPending}
          />
        ))}
      </div>
    </div>
  );
}

function IncrementCard({
  inc,
  verdicts,
  onApprove,
  onMerge,
  busy,
}: {
  inc: IncrementDetail;
  verdicts: GateVerdictView[];
  onApprove: () => void;
  onMerge: () => void;
  busy: boolean;
}) {
  const s = inc.state.status;
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "var(--space-4)",
        display: "grid",
        gap: "var(--space-3)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)" }}>
        <strong>{inc.title}</strong>
        <span style={{ color: STATE_COLOR[s], whiteSpace: "nowrap" }}>{STATE_LABEL[s] ?? s}</span>
      </div>

      {inc.repairAttempt > 0 && (
        <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>repair attempt {inc.repairAttempt}</div>
      )}

      {verdicts.length > 0 && (
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          {verdicts.map((v) => (
            <span
              key={v.gate}
              title={v.findings.map((f) => `${f.dimension}: ${f.message}`).join("\n")}
              style={{
                fontSize: "var(--fs-sm)",
                padding: "2px var(--space-2)",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                color:
                  v.outcome === "pass" ? "var(--ok)" : v.outcome === "fail" ? "var(--fail)" : "var(--text-dim)",
              }}
            >
              {v.gate}: {v.outcome}
            </span>
          ))}
        </div>
      )}

      {verdicts.some((v) => v.outcome === "fail") && (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          {verdicts
            .filter((v) => v.outcome === "fail")
            .flatMap((v) => v.findings.slice(0, 3).map((f, i) => (
              <code key={`${v.gate}${i}`} style={{ color: "var(--fail)" }}>
                [{v.gate}] {f.dimension}: {f.message}
              </code>
            )))}
        </div>
      )}

      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        {s === "CONTEXT_READY" && (
          <button className="primary" disabled={busy} onClick={onApprove}>
            Approve & start (signature 1)
          </button>
        )}
        {s === "AWAITING_SIGNATURE" && (
          <button className="primary" disabled={busy} onClick={onMerge}>
            Merge (signature 2)
          </button>
        )}
      </div>
    </div>
  );
}
