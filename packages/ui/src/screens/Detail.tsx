// Screen 2: feature detail — the pipeline rail with every control:
// approve · merge · answer escalation · retry · abort, plus live activity
// (phases, tokens, last error) per increment.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActivityView, EscalationView, GateVerdictView, IncrementDetail } from "@signet/contracts";
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
  ESCALATED: "question raised — answer below",
  PARKED: "parked (quota) — resumes automatically",
  FAILED: "failed — retry available",
};

export function Detail({ featureId, onBack }: { featureId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ["feature", featureId],
    queryFn: () => api.feature(featureId),
    refetchInterval: 3000,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["feature", featureId] });
  const act = {
    approve: useMutation({ mutationFn: api.approve, onSuccess: invalidate }),
    merge: useMutation({ mutationFn: api.merge, onSuccess: invalidate }),
    retry: useMutation({ mutationFn: api.retry, onSuccess: invalidate }),
    abort: useMutation({ mutationFn: api.abort, onSuccess: invalidate }),
  };

  if (!detail.data) return <div style={{ padding: "var(--space-8)" }}>Loading…</div>;
  const { feature, increments, verdicts, activity, escalations } = detail.data;
  const escByInc = new Map(escalations.map((e) => [e.incrementId as string, e]));

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
            activity={activity[inc.id]}
            escalation={escByInc.get(inc.id)}
            act={act}
            onAnswered={invalidate}
          />
        ))}
      </div>
    </div>
  );
}

function IncrementCard({
  inc,
  verdicts,
  activity,
  escalation,
  act,
  onAnswered,
}: {
  inc: IncrementDetail;
  verdicts: GateVerdictView[];
  activity: ActivityView | undefined;
  escalation: EscalationView | undefined;
  act: Record<"approve" | "merge" | "retry" | "abort", { mutate: (id: string) => void; isPending: boolean }>;
  onAnswered: () => void;
}) {
  const s = inc.state.status;
  const busy = act.approve.isPending || act.merge.isPending || act.retry.isPending || act.abort.isPending;
  const [showActivity, setShowActivity] = useState(false);

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

      {s === "FAILED" && inc.state.status === "FAILED" && (
        <code style={{ color: "var(--fail)" }}>{inc.state.reason}</code>
      )}
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
                color: v.outcome === "pass" ? "var(--ok)" : v.outcome === "fail" ? "var(--fail)" : "var(--text-dim)",
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
            .flatMap((v) =>
              v.findings.slice(0, 3).map((f, i) => (
                <code key={`${v.gate}${i}`} style={{ color: "var(--fail)" }}>
                  [{v.gate}] {f.dimension}: {f.message}
                </code>
              )),
            )}
        </div>
      )}

      {escalation && <EscalationBox escalation={escalation} onAnswered={onAnswered} />}

      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        {s === "CONTEXT_READY" && (
          <button className="primary" disabled={busy} onClick={() => act.approve.mutate(inc.id)}>
            Approve & start (signature 1)
          </button>
        )}
        {s === "AWAITING_SIGNATURE" && (
          <button className="primary" disabled={busy} onClick={() => act.merge.mutate(inc.id)}>
            Merge (signature 2)
          </button>
        )}
        {s === "FAILED" && (
          <button disabled={busy} onClick={() => act.retry.mutate(inc.id)}>
            Retry
          </button>
        )}
        {(s === "RUNNING" || s === "VERIFYING") && (
          <button disabled={busy} onClick={() => act.abort.mutate(inc.id)} style={{ color: "var(--fail)" }}>
            Abort
          </button>
        )}
        {activity && activity.phases.length > 0 && (
          <button onClick={() => setShowActivity(!showActivity)}>
            {showActivity ? "hide activity" : "activity"}
          </button>
        )}
      </div>

      {showActivity && activity && <ActivityRail activity={activity} />}
    </div>
  );
}

function EscalationBox({ escalation, onAnswered }: { escalation: EscalationView; onAnswered: () => void }) {
  const [answer, setAnswer] = useState("");
  const answerMut = useMutation({
    mutationFn: () => api.answerEscalation(escalation.id, answer),
    onSuccess: onAnswered,
  });
  return (
    <div
      style={{
        border: "1px solid var(--warn)",
        borderRadius: "var(--radius-sm)",
        padding: "var(--space-3)",
        display: "grid",
        gap: "var(--space-2)",
      }}
    >
      <div style={{ color: "var(--warn)", fontWeight: 600 }}>The agent asks:</div>
      <div>{escalation.question}</div>
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="Your answer amends the brief (a new frozen version) and the increment resumes."
        style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          color: "var(--text)",
          padding: "var(--space-2)",
          font: "inherit",
          minHeight: 64,
        }}
      />
      <button
        className="primary"
        disabled={answer.trim().length === 0 || answerMut.isPending}
        onClick={() => answerMut.mutate()}
        style={{ justifySelf: "start" }}
      >
        Answer & resume
      </button>
    </div>
  );
}

function ActivityRail({ activity }: { activity: ActivityView }) {
  return (
    <div style={{ display: "grid", gap: "var(--space-2)", borderTop: "1px solid var(--border)", paddingTop: "var(--space-3)" }}>
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        {activity.phases.map((p, i) => (
          <span
            key={i}
            style={{
              fontSize: "var(--fs-sm)",
              fontFamily: "var(--mono)",
              color: p.completedAt ? "var(--ok)" : "var(--running)",
            }}
          >
            {p.phase.toLowerCase()}
            {p.attempt > 1 ? `#${p.attempt}` : ""}
            {i < activity.phases.length - 1 ? " →" : ""}
          </span>
        ))}
      </div>
      <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)", fontFamily: "var(--mono)" }}>
        in {activity.usage.inputTokens.toLocaleString()} (cached {activity.usage.cachedInputTokens.toLocaleString()}) ·
        out {activity.usage.outputTokens.toLocaleString()}
        {activity.usage.costUsd !== null ? ` · $${activity.usage.costUsd.toFixed(4)}` : ""}
      </div>
      {activity.lastError && <code style={{ color: "var(--fail)" }}>{activity.lastError}</code>}
    </div>
  );
}
