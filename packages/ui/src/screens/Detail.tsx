// Screen 2: feature detail — the pipeline rail with every control:
// approve · merge · answer escalation · retry · abort, plus the design of
// record, the gate verdicts with their findings spelled out, the diff under
// review, and live activity per increment.
//
// Two rules this screen obeys: nothing fails silently, and no signature is
// asked for without the evidence for it on screen.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActivityView, EscalationView, GateVerdictView, IncrementDetail } from "@signet/contracts";
import { api } from "../api.js";
import { Disclosure, ErrorNote, QueryState } from "../components.js";
import { DesignPanel } from "./DesignPanel.js";
import { DiffView } from "./DiffView.js";

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

/** Which gate blocked, in the user's words, for the banner above the buttons. */
const GATE_MEANING: Record<string, string> = {
  typecheck: "the code does not typecheck",
  lint: "the code breaks lint",
  tests: "the tests do not pass, or do not fail without the change",
  rules: "it breaks a confirmed rule from your constitution",
  conformance: "it diverges from the approved design of record",
};

export function Detail({ featureId, onBack }: { featureId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ["feature", featureId],
    queryFn: () => api.feature(featureId),
    refetchInterval: 3000,
  });

  return (
    <QueryState isPending={detail.isPending} error={detail.error} onRetry={() => void detail.refetch()}>
      {detail.data && (
        <Loaded
          data={detail.data}
          onBack={onBack}
          invalidate={() => {
            void qc.invalidateQueries({ queryKey: ["feature", featureId] });
            void qc.invalidateQueries({ queryKey: ["features"] });
          }}
        />
      )}
    </QueryState>
  );
}

function Loaded({
  data,
  onBack,
  invalidate,
}: {
  data: Awaited<ReturnType<typeof api.feature>>;
  onBack: () => void;
  invalidate: () => void;
}) {
  const { feature, increments, verdicts, activity, escalations } = data;
  const escByInc = new Map(escalations.map((e) => [e.incrementId as string, e]));

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "var(--space-8) var(--space-4)" }}>
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
            invalidate={invalidate}
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
  invalidate,
}: {
  inc: IncrementDetail;
  verdicts: GateVerdictView[];
  activity: ActivityView | undefined;
  escalation: EscalationView | undefined;
  invalidate: () => void;
}) {
  const s = inc.state.status;
  // Each action keeps its own error so the message lands on the button pressed.
  const approve = useMutation({ mutationFn: api.approve, onSuccess: invalidate });
  const merge = useMutation({ mutationFn: api.merge, onSuccess: invalidate });
  const retry = useMutation({ mutationFn: api.retry, onSuccess: invalidate });
  const abort = useMutation({ mutationFn: api.abort, onSuccess: invalidate });
  const acts = [approve, merge, retry, abort];
  const busy = acts.some((a) => a.isPending);
  const failure = acts.find((a) => a.error)?.error;

  const failed = verdicts.filter((v) => v.outcome === "fail");
  // The design is editable up to the moment the agent starts reading it.
  const designEditable = s === "PLANNED" || s === "CONTEXT_READY" || s === "FAILED";

  return (
    <div
      style={{
        background: "var(--surface)",
        border: `1px solid ${failed.length > 0 ? "var(--fail)" : "var(--border)"}`,
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

      {inc.state.status === "FAILED" && <code style={{ color: "var(--fail)" }}>{inc.state.reason}</code>}
      {inc.repairAttempt > 0 && (
        <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>repair attempt {inc.repairAttempt}</div>
      )}

      <DesignPanel incrementId={inc.id} editable={designEditable} />

      {verdicts.length > 0 && <GateStrip verdicts={verdicts} />}

      {failed.length > 0 && (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <div style={{ color: "var(--fail)", fontWeight: 600 }}>
            Blocked because {failed.map((v) => GATE_MEANING[v.gate] ?? v.gate).join(", and ")}.
          </div>
          {failed.map((v) => (
            <Findings key={v.gate} verdict={v} />
          ))}
        </div>
      )}

      {escalation && <EscalationBox escalation={escalation} onAnswered={invalidate} />}

      {(s === "AWAITING_SIGNATURE" || s === "VERIFYING" || failed.length > 0) && (
        <Disclosure label="Changes under review" defaultOpen={s === "AWAITING_SIGNATURE"}>
          <DiffView incrementId={inc.id} />
        </Disclosure>
      )}

      <ErrorNote error={failure} onDismiss={() => acts.forEach((a) => a.reset())} />

      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
        {s === "CONTEXT_READY" && (
          <button className="primary" disabled={busy} onClick={() => approve.mutate(inc.id)}>
            {approve.isPending ? "Starting…" : "Approve & start (signature 1)"}
          </button>
        )}
        {s === "AWAITING_SIGNATURE" && (
          <button className="primary" disabled={busy} onClick={() => merge.mutate(inc.id)}>
            {merge.isPending ? "Merging…" : "Merge (signature 2)"}
          </button>
        )}
        {s === "FAILED" && (
          <button disabled={busy} onClick={() => retry.mutate(inc.id)}>
            {retry.isPending ? "Retrying…" : "Retry"}
          </button>
        )}
        {(s === "RUNNING" || s === "VERIFYING") && (
          <button disabled={busy} onClick={() => abort.mutate(inc.id)} style={{ color: "var(--fail)" }}>
            {abort.isPending ? "Aborting…" : "Abort"}
          </button>
        )}
        {activity && activity.phases.length > 0 && (
          <Disclosure label="Activity" count={activity.phases.length}>
            <ActivityRail activity={activity} />
          </Disclosure>
        )}
      </div>

      <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)", fontFamily: "var(--mono)" }}>
        surface: {inc.declaredSurface.join(", ") || "—"}
      </div>
    </div>
  );
}

function GateStrip({ verdicts }: { verdicts: GateVerdictView[] }) {
  return (
    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
      {verdicts.map((v) => (
        <span
          key={v.gate}
          style={{
            fontSize: "var(--fs-sm)",
            padding: "2px var(--space-2)",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            color:
              v.outcome === "pass"
                ? "var(--ok)"
                : v.outcome === "fail"
                  ? "var(--fail)"
                  : v.outcome === "warn"
                    ? "var(--warn)"
                    : "var(--text-dim)",
          }}
        >
          {v.gate}: {v.outcome}
          {v.findings.length > 0 && v.outcome !== "fail" ? ` · ${v.findings.length}` : ""}
        </span>
      ))}
    </div>
  );
}

/** Findings in full. They are the product's output; hiding them in a tooltip wastes them. */
function Findings({ verdict }: { verdict: GateVerdictView }) {
  return (
    <div style={{ display: "grid", gap: "var(--space-1)" }}>
      {verdict.findings.map((f, i) => (
        <div key={i} style={{ display: "flex", gap: "var(--space-2)", alignItems: "baseline" }}>
          <span
            style={{
              color: "var(--text-dim)",
              fontSize: "var(--fs-sm)",
              minWidth: 110,
              fontFamily: "var(--mono)",
            }}
          >
            {verdict.gate}/{f.dimension}
          </span>
          <span>
            {f.message}
            {f.location ? <code style={{ color: "var(--text-dim)" }}> ({f.location})</code> : null}
          </span>
        </div>
      ))}
      {verdict.findings.length === 0 && (
        <span style={{ color: "var(--text-dim)" }}>No detail was recorded for this failure.</span>
      )}
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
      <ErrorNote error={answerMut.error} onDismiss={() => answerMut.reset()} />
      <button
        className="primary"
        disabled={answer.trim().length === 0 || answerMut.isPending}
        onClick={() => answerMut.mutate()}
        style={{ justifySelf: "start" }}
      >
        {answerMut.isPending ? "Sending…" : "Answer & resume"}
      </button>
    </div>
  );
}

function ActivityRail({ activity }: { activity: ActivityView }) {
  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
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
