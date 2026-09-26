// Feature detail: everything about one feature and its increments.
//
// This is where the two signatures happen, so it obeys two rules absolutely.
// Nothing fails silently — every action shows its result or why it was refused.
// And no signature is requested without the evidence for it on screen: the diff
// is right there under the merge button, along with the gate findings, the design
// that was approved, and what the agent was given to work from.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActivityView, EscalationView, GateVerdictView, IncrementDetail } from "@signet/contracts";
import { api } from "../api.js";
import { navigate, type Route } from "../router.js";
import {
  Badge,
  Button,
  Card,
  Divider,
  Dot,
  Meter,
  Row,
  SectionTitle,
  Segmented,
  Stack,
  TextArea,
} from "../ui/primitives.js";
import { ConfirmButton, ErrorNote, QueryState, useToast } from "../ui/feedback.js";
import {
  Bytes,
  CodeBlock,
  Duration,
  GateBadge,
  Id,
  INCREMENT_STATE,
  LiveDuration,
  Money,
  RelativeTime,
  StateBadge,
  TokenCount,
} from "../ui/format.js";
import { DesignPanel } from "./DesignPanel.js";
import { DiffView } from "./DiffView.js";

/** Why a gate blocking matters, in the operator's language. */
const GATE_MEANING: Record<string, string> = {
  typecheck: "it does not typecheck",
  lint: "it breaks lint",
  tests: "the tests do not pass, or do not fail without the change",
  rules: "it breaks a confirmed rule from your constitution",
  conformance: "it diverges from the approved design of record",
};

const TABS = [
  { value: "increments", label: "Increments" },
  { value: "brief", label: "Brief" },
  { value: "runs", label: "Runs" },
] as const;

export function Feature({ route }: { route: Extract<Route, { view: "feature" }> }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["feature", route.id],
    queryFn: () => api.feature(route.id),
    refetchInterval: 3000,
  });
  const tab = route.tab ?? "increments";

  const invalidate = () => {
    for (const key of ["feature", "features", "overview", "runs", "activity"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };

  return (
    <QueryState isPending={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeletonRows={4}>
      {q.data && (
        <Stack gap="var(--s5)">
          <Stack gap="var(--s3)">
            <Row justify="space-between" wrap gap="var(--s3)">
              <Stack gap="var(--s1)">
                <Row gap="var(--s2)">
                  <h1 style={{ fontSize: "var(--fs-xl)" }}>{q.data.feature.title}</h1>
                  {q.data.feature.needsHuman && <Badge tone="warn">needs you</Badge>}
                </Row>
                <Row gap="var(--s3)" style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
                  <span className="num">
                    {q.data.feature.incrementsMerged}/{q.data.feature.incrementsTotal} merged
                  </span>
                  <div style={{ width: 90 }}>
                    <Meter
                      value={q.data.feature.incrementsMerged}
                      max={q.data.feature.incrementsTotal}
                      tone={q.data.feature.incrementsMerged === q.data.feature.incrementsTotal ? "ok" : "accent"}
                    />
                  </div>
                  <Id value={q.data.feature.id} label="feature" />
                </Row>
              </Stack>
              <Button variant="quiet" onClick={() => navigate({ view: "work" })}>
                ← all work
              </Button>
            </Row>
            <Segmented
              options={TABS.map((t) => ({
                ...t,
                ...(t.value === "increments" ? { count: q.data.increments.length } : {}),
              }))}
              value={tab}
              onChange={(v) => navigate({ view: "feature", id: route.id, tab: v })}
            />
          </Stack>

          {tab === "increments" && (
            <Stack gap="var(--s3)">
              {q.data.increments.map((inc) => (
                <IncrementCard
                  key={inc.id}
                  inc={inc}
                  verdicts={q.data.verdicts[inc.id] ?? []}
                  activity={q.data.activity[inc.id]}
                  escalation={q.data.escalations.find((e) => e.incrementId === inc.id)}
                  invalidate={invalidate}
                />
              ))}
            </Stack>
          )}

          {tab === "brief" && <BriefTab increments={q.data.increments} />}
          {tab === "runs" && <RunsTab featureId={route.id} increments={q.data.increments} />}
        </Stack>
      )}
    </QueryState>
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
  const toast = useToast();
  const s = inc.state.status;
  const meta = INCREMENT_STATE[s];

  // Each action owns its error, so the message lands on the button pressed.
  const approve = useMutation({
    mutationFn: api.approve,
    onSuccess: () => {
      toast.push("Run started", "ok");
      invalidate();
    },
  });
  const merge = useMutation({
    mutationFn: api.merge,
    onSuccess: () => {
      toast.push("Merged into the base branch", "ok");
      invalidate();
    },
  });
  const retry = useMutation({ mutationFn: api.retry, onSuccess: invalidate });
  const abort = useMutation({
    mutationFn: api.abort,
    onSuccess: () => {
      toast.push("Abort signalled", "warn");
      invalidate();
    },
  });
  const acts = [approve, merge, retry, abort];
  const busy = acts.some((a) => a.isPending);
  const failure = acts.find((a) => a.error)?.error;

  const failed = verdicts.filter((v) => v.outcome === "fail");
  const designEditable = s === "PLANNED" || s === "CONTEXT_READY" || s === "FAILED";
  const showDiff = s === "AWAITING_SIGNATURE" || s === "VERIFYING" || s === "MERGED" || failed.length > 0;

  return (
    <Card tone={failed.length > 0 ? "err" : s === "AWAITING_SIGNATURE" ? "warn" : "neutral"}>
      <Stack gap="var(--s4)">
        <Row justify="space-between" wrap gap="var(--s3)">
          <Stack gap="var(--s1)" style={{ minWidth: 0 }}>
            <Row gap="var(--s2)" wrap>
              <strong style={{ fontSize: "var(--fs-md)" }}>{inc.title}</strong>
              <StateBadge status={s} />
              {inc.repairAttempt > 0 && <Badge tone="warn">repair {inc.repairAttempt}</Badge>}
            </Row>
            <span style={{ color: "var(--fg-muted)" }}>{meta?.help}</span>
          </Stack>
          <Id value={inc.id} label="increment" />
        </Row>

        {inc.state.status === "FAILED" && (
          <div
            style={{
              border: "1px solid var(--err)",
              background: "var(--err-quiet)",
              borderRadius: "var(--r-sm)",
              padding: "var(--s2) var(--s3)",
              color: "var(--err)",
              fontFamily: "var(--mono)",
              fontSize: "var(--fs-sm)",
            }}
          >
            {inc.state.reason}
          </div>
        )}

        <DesignPanel incrementId={inc.id} editable={designEditable} />

        {verdicts.length > 0 && (
          <Stack gap="var(--s2)">
            <Row gap="var(--s1)" wrap>
              {verdicts.map((v) => (
                <GateBadge key={v.gate} gate={v.gate} outcome={v.outcome} count={v.findings.length} />
              ))}
            </Row>
            {failed.length > 0 && (
              <Stack gap="var(--s2)">
                <strong style={{ color: "var(--err)" }}>
                  Blocked because {failed.map((v) => GATE_MEANING[v.gate] ?? v.gate).join(", and ")}.
                </strong>
                {failed.map((v) => (
                  <Findings key={v.gate} verdict={v} />
                ))}
              </Stack>
            )}
          </Stack>
        )}

        {escalation && <EscalationBox escalation={escalation} onAnswered={invalidate} />}

        {showDiff && (
          <Stack gap="var(--s2)">
            <SectionTitle>
              {s === "AWAITING_SIGNATURE" ? "What you are about to merge" : "Changes"}
            </SectionTitle>
            <DiffView incrementId={inc.id} />
          </Stack>
        )}

        <ErrorNote error={failure} onDismiss={() => acts.forEach((a) => a.reset())} />

        <Divider />

        <Row justify="space-between" wrap gap="var(--s3)">
          <Row gap="var(--s2)" wrap>
            {s === "CONTEXT_READY" && (
              <Button variant="primary" disabled={busy} onClick={() => approve.mutate(inc.id)}>
                {approve.isPending ? "Starting…" : "Approve & start · signature 1"}
              </Button>
            )}
            {s === "AWAITING_SIGNATURE" && (
              <ConfirmButton
                question="This merges the branch into the base branch."
                confirmLabel="Merge it"
                disabled={busy}
                onConfirm={() => merge.mutate(inc.id)}
              >
                Merge · signature 2
              </ConfirmButton>
            )}
            {s === "FAILED" && (
              <Button disabled={busy} onClick={() => retry.mutate(inc.id)}>
                {retry.isPending ? "Retrying…" : "Retry"}
              </Button>
            )}
            {(s === "RUNNING" || s === "VERIFYING") && (
              <ConfirmButton
                variant="danger"
                question="The worker is stopped; the worktree is kept."
                confirmLabel="Abort it"
                disabled={busy}
                onConfirm={() => abort.mutate(inc.id)}
              >
                Abort
              </ConfirmButton>
            )}
            <PackButton incrementId={inc.id} />
          </Row>
          {activity && <ActivitySummary activity={activity} />}
        </Row>

        {activity && activity.phases.length > 0 && <PhaseRail activity={activity} />}

        <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)", fontFamily: "var(--mono)" }}>
          declared surface: {inc.declaredSurface.join(", ") || "—"}
        </span>
      </Stack>
    </Card>
  );
}

function Findings({ verdict }: { verdict: GateVerdictView }) {
  if (verdict.findings.length === 0) {
    return <span style={{ color: "var(--fg-muted)" }}>No detail was recorded for this failure.</span>;
  }
  return (
    <Stack gap="var(--s1)">
      {verdict.findings.map((f, i) => (
        <Row key={i} gap="var(--s2)" align="baseline">
          <span
            style={{
              minWidth: 130,
              color: "var(--fg-subtle)",
              fontFamily: "var(--mono)",
              fontSize: "var(--fs-xs)",
              flex: "0 0 auto",
            }}
          >
            {verdict.gate}/{f.dimension}
          </span>
          <span style={{ minWidth: 0 }}>
            {f.message}
            {f.location && <span style={{ color: "var(--fg-subtle)" }}> ({f.location})</span>}
          </span>
        </Row>
      ))}
    </Stack>
  );
}

/** "What did the agent know" — the pack manifest, on demand. */
function PackButton({ incrementId }: { incrementId: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["pack", incrementId],
    queryFn: () => api.pack(incrementId),
    enabled: open,
  });

  if (!open) {
    return (
      <Button variant="quiet" onClick={() => setOpen(true)} title="The context pack the agent was given">
        What it knew
      </Button>
    );
  }
  return (
    <Stack gap="var(--s2)" style={{ width: "100%" }}>
      <Row justify="space-between">
        <strong>Context pack</strong>
        <Button size="sm" variant="quiet" onClick={() => setOpen(false)}>
          hide
        </Button>
      </Row>
      {q.isPending && <span style={{ color: "var(--fg-muted)" }}>Reading the manifest…</span>}
      {q.error && <ErrorNote error={q.error} />}
      {q.data === null && (
        <span style={{ color: "var(--fg-muted)" }}>
          No pack yet — this increment has not run, so nothing has been assembled for it.
        </span>
      )}
      {q.data && (
        <Card padding="var(--s3)">
          <Stack gap="var(--s2)">
            {q.data.sections.map((s) => (
              <Row key={s.name} justify="space-between" gap="var(--s3)">
                <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-sm)" }}>{s.name}</span>
                <Row gap="var(--s3)" style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
                  <Bytes n={s.bytes} />
                  <span style={{ color: "var(--fg-subtle)", fontFamily: "var(--mono)" }}>
                    {s.sha256.slice(0, 8)}
                  </span>
                </Row>
              </Row>
            ))}
            <Divider />
            <Row justify="space-between">
              <span style={{ color: "var(--fg-muted)" }}>
                {q.data.sections.length} sections · <Bytes n={q.data.totalBytes} />
              </span>
              <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
                assembled <RelativeTime iso={q.data.assembledAt} />
              </span>
            </Row>
            <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
              Hashed per section, so the same pack is reproducible and a changed input is visible.
            </span>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

function ActivitySummary({ activity }: { activity: ActivityView }) {
  return (
    <Row gap="var(--s3)" style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
      <span>
        in <TokenCount n={activity.usage.inputTokens} />
        {activity.usage.cachedInputTokens > 0 && (
          <span style={{ color: "var(--fg-subtle)" }}>
            {" "}
            (<TokenCount n={activity.usage.cachedInputTokens} /> cached)
          </span>
        )}
      </span>
      <span>
        out <TokenCount n={activity.usage.outputTokens} />
      </span>
      <Money usd={activity.usage.costUsd} />
    </Row>
  );
}

function PhaseRail({ activity }: { activity: ActivityView }) {
  return (
    <Row gap="var(--s2)" wrap style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-xs)" }}>
      {activity.phases.map((p, i) => (
        <Row key={`${p.phase}-${i}`} gap="var(--s1)">
          <Dot tone={p.completedAt ? "ok" : "run"} pulse={!p.completedAt} />
          <span style={{ color: p.completedAt ? "var(--fg-muted)" : "var(--run)" }}>
            {p.phase.toLowerCase()}
            {p.attempt > 1 ? `#${p.attempt}` : ""}
          </span>
          {p.completedAt ? (
            <span style={{ color: "var(--fg-subtle)" }}>
              <Duration ms={new Date(p.completedAt).getTime() - new Date(p.enteredAt).getTime()} />
            </span>
          ) : (
            <span style={{ color: "var(--run)" }}>
              <LiveDuration since={p.enteredAt} />
            </span>
          )}
          {i < activity.phases.length - 1 && <span style={{ color: "var(--fg-subtle)" }}>→</span>}
        </Row>
      ))}
      {activity.lastError && (
        <Badge tone="err" mono>
          {activity.lastError}
        </Badge>
      )}
    </Row>
  );
}

function EscalationBox({ escalation, onAnswered }: { escalation: EscalationView; onAnswered: () => void }) {
  const [answer, setAnswer] = useState("");
  const toast = useToast();
  const mut = useMutation({
    mutationFn: () => api.answerEscalation(escalation.id, answer),
    onSuccess: () => {
      toast.push("Answered — the brief is amended and the increment resumes", "ok");
      onAnswered();
    },
  });

  return (
    <Card tone="warn" padding="var(--s3)">
      <Stack gap="var(--s2)">
        <Row gap="var(--s2)">
          <Dot tone="warn" />
          <strong style={{ color: "var(--warn)" }}>The agent stopped to ask rather than guess</strong>
          <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
            <RelativeTime iso={escalation.raisedAt} />
          </span>
        </Row>
        <p>{escalation.question}</p>
        <TextArea
          value={answer}
          onChange={setAnswer}
          rows={3}
          placeholder="Your answer becomes a new frozen version of the brief, and the increment resumes from there."
        />
        <ErrorNote error={mut.error} onDismiss={() => mut.reset()} />
        <Button
          variant="primary"
          disabled={answer.trim().length === 0 || mut.isPending}
          onClick={() => mut.mutate()}
          style={{ justifySelf: "start" }}
        >
          {mut.isPending ? "Sending…" : "Answer & resume"}
        </Button>
      </Stack>
    </Card>
  );
}

function BriefTab({ increments }: { increments: IncrementDetail[] }) {
  return (
    <Stack gap="var(--s3)">
      <SectionTitle>Declared surface per increment</SectionTitle>
      <Card>
        <Stack gap="var(--s3)">
          {increments.map((inc) => (
            <Stack key={inc.id} gap="var(--s1)">
              <Row gap="var(--s2)">
                <strong>{inc.title}</strong>
                <StateBadge status={inc.state.status} />
              </Row>
              <CodeBlock text={inc.declaredSurface.join("\n") || "(no surface declared)"} maxHeight={120} />
            </Stack>
          ))}
        </Stack>
      </Card>
      <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
        The declared surface is the contract for the increment: a change outside it is caught by the
        scope checker rather than reviewed on trust.
      </span>
    </Stack>
  );
}

/** Every run of every increment in this feature, for the "what has it tried" question. */
function RunsTab({ featureId, increments }: { featureId: string; increments: IncrementDetail[] }) {
  const q = useQuery({
    queryKey: ["runs", "feature", featureId],
    queryFn: async () => {
      const lists = await Promise.all(increments.map((i) => api.runs({ incrementId: i.id, limit: 50 })));
      return lists.flat().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },
    refetchInterval: 5000,
  });

  return (
    <QueryState isPending={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeletonRows={3}>
      <Stack gap="var(--s2)">
        {(q.data ?? []).length === 0 && (
          <span style={{ color: "var(--fg-muted)" }}>No runs yet for this feature.</span>
        )}
        {(q.data ?? []).map((r) => (
          <Card key={r.id} padding="var(--s3)">
            <Row justify="space-between" wrap gap="var(--s3)">
              <Row gap="var(--s2)" wrap>
                <Badge tone={r.outcome === "succeeded" ? "ok" : r.outcome === "failed" ? "err" : "run"}>
                  {r.outcome}
                </Badge>
                <span>{r.incrementTitle}</span>
                {r.repairs > 0 && (
                  <Badge tone="warn">
                    {r.repairs} repair{r.repairs === 1 ? "" : "s"}
                  </Badge>
                )}
                {r.gatesFailed.map((g) => (
                  <Badge key={g} tone="err" mono>
                    {g} blocked
                  </Badge>
                ))}
                {r.gatesRepaired.map((g) => (
                  <Badge key={g} tone="ok" mono>
                    {g} ✓ repaired
                  </Badge>
                ))}
              </Row>
              <Row gap="var(--s4)" style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
                <Duration ms={r.durationMs} />
                <Money usd={r.costUsd} />
                <RelativeTime iso={r.startedAt} />
                <Button size="sm" variant="quiet" onClick={() => navigate({ view: "runs", selected: r.id })}>
                  inspect →
                </Button>
              </Row>
            </Row>
          </Card>
        ))}
      </Stack>
    </QueryState>
  );
}
