// Feature detail: everything about one feature and its increments.
//
// This is where the two signatures happen, so it obeys two rules absolutely.
// Nothing fails silently — every action shows its result or why it was refused.
// And no signature is requested without the evidence for it on screen: the diff
// is right there under the merge button, along with the gate findings, the design
// that was approved, and what the agent was given to work from.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ActivityView,
  BriefVersionView,
  EscalationView,
  GateVerdictView,
  IncrementDetail,
} from "@signet/contracts";
import { api } from "../api.js";
import { navigate, type Route } from "../router.js";
import {
  Badge,
  Button,
  Card,
  Divider,
  Dot,
  Row,
  Segmented,
  Stack,
  TextArea,
} from "../ui/primitives.js";
import { ConfirmButton, EmptyState, ErrorNote, QueryState, useToast } from "../ui/feedback.js";
import { Forensics, RowDivider, Understand } from "../ui/tiers.js";
import { Journey } from "../ui/journey.js";
import { LiveRun } from "../ui/live-run.js";
import { RunPipeline } from "../ui/run-pipeline.js";
import { StepStrip } from "../ui/step-strip.js";
import {
  Bytes,
  CodeBlock,
  Duration,
  GateBadge,
  CHECK_NAME,
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
  typecheck: "the types do not line up",
  lint: "it breaks your lint rules",
  tests: "the tests do not pass, or would pass without the change too",
  rules: "it breaks a rule you accepted",
  conformance: "it does not match the approved design",
};

const TABS = [
  { value: "increments", label: "Steps" },
  { value: "brief", label: "What you asked for" },
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
                    {q.data.feature.incrementsMerged}/{q.data.feature.incrementsTotal} steps done
                  </span>
                  <div style={{ width: 120 }}>
                    <StepStrip states={q.data.feature.stepStates} size="page" />
                  </div>
                  {q.data.feature.repoLabel && (
                    <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-xs)" }}>
                      {q.data.feature.repoLabel}
                    </span>
                  )}
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

          {tab === "brief" && <RequestTab briefs={q.data.briefs} increments={q.data.increments} />}
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
  // Only some states carry a run. Narrowing through the union rather than casting
  // keeps the live panel from being handed an id that does not exist yet.
  const runId = "runId" in inc.state ? inc.state.runId : null;

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
          <Id value={inc.id} label="step" />
        </Row>

        {/* Where this step is, drawn. The badge above says the current state; this
            says the shape of the journey and which of the two signatures is owed. */}
        <Journey status={s} repairAttempt={inc.repairAttempt} />

        {/* What is happening right now, only while something is. Everything here was
            already recorded during a run and only shown after it ended, which made a
            healthy slow run indistinguishable from a wedged one. */}
        {(s === "RUNNING" || s === "VERIFYING") && runId && <LiveRun runId={runId} verdicts={verdicts} />}

        {/* The pipeline, drawn. Disclosed rather than always open: the rail above answers
            "where is this", and the diagram answers "what actually happened", which is a
            different and less frequent question. Shown for any step that has started,
            including failed ones — a failure is exactly when the shape is worth seeing. */}
        {s !== "CONTEXT_READY" && s !== "PLANNED" && (
          <Forensics id={`pipeline.${inc.id}`} label="See the pipeline">
            <div style={{ padding: "var(--s3)" }}>
              <RunPipeline incrementId={inc.id} incrementStatus={s} verdicts={verdicts} />
            </div>
          </Forensics>
        )}

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

        {/* Open when a signature is being asked for — nobody should sign blind — and
            collapsed once merged, when it becomes history rather than a decision. */}
        {showDiff &&
          (s === "AWAITING_SIGNATURE" ? (
            <Understand title="What you are about to merge">
              <DiffView incrementId={inc.id} />
            </Understand>
          ) : (
            <Forensics id={`diff.${inc.id}`} label="Changes">
              <DiffView incrementId={inc.id} />
            </Forensics>
          ))}

        <ErrorNote error={failure} onDismiss={() => acts.forEach((a) => a.reset())} />

        <Divider />

        <Row justify="space-between" wrap gap="var(--s3)">
          <Row gap="var(--s2)" wrap>
            {s === "CONTEXT_READY" && (
              <Button variant="primary" disabled={busy} onClick={() => approve.mutate(inc.id)}>
                {approve.isPending ? "Starting…" : "Approve and start"}
              </Button>
            )}
            {s === "AWAITING_SIGNATURE" && (
              <ConfirmButton
                question="This lands the change on your main branch."
                confirmLabel="Merge it"
                disabled={busy}
                onConfirm={() => merge.mutate(inc.id)}
              >
                Merge
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
                question="Signet stops working on this. Nothing it wrote is thrown away."
                confirmLabel="Abort it"
                disabled={busy}
                onConfirm={() => abort.mutate(inc.id)}
              >
                Abort
              </ConfirmButton>
            )}
          </Row>
          {activity && <ActivitySummary activity={activity} />}
        </Row>

        {/* Tier three. Real information, wanted rarely: how long each phase took,
            what the agent was given, and what it was allowed to touch. Collapsed by
            default and remembered once opened. */}
        <RowDivider />
        <Forensics id={`detail.${inc.id}`} label="Timings, briefing and file limits">
          <Stack gap="var(--s4)">
            {activity && activity.phases.length > 0 && (
              <Understand title="Phases">
                <PhaseRail activity={activity} />
              </Understand>
            )}
            <Understand title="What it was given">
              <PackPanel incrementId={inc.id} />
            </Understand>
            <Understand title="Files it may change">
              <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-sm)", color: "var(--fg-muted)" }}>
                {inc.declaredSurface.join(", ") || "anything"}
              </span>
            </Understand>
          </Stack>
        </Forensics>
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
            {CHECK_NAME[verdict.gate] ?? verdict.gate} · {f.dimension}
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

/**
 * The context pack the agent was given. Lives inside the forensics disclosure, so
 * it has no toggle of its own — and it only fetches once that disclosure is open,
 * which is why `enabled` tracks mount rather than a local flag.
 */
function PackPanel({ incrementId }: { incrementId: string }) {
  const q = useQuery({ queryKey: ["pack", incrementId], queryFn: () => api.pack(incrementId) });

  return (
    <Stack gap="var(--s2)" style={{ width: "100%" }}>
      {q.isPending && <span style={{ color: "var(--fg-muted)" }}>Reading the manifest…</span>}
      {q.error && <ErrorNote error={q.error} />}
      {q.data === null && (
        <span style={{ color: "var(--fg-muted)" }}>
          Nothing yet — this step has not run, so there is no briefing to show.
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
      toast.push("Answered — Signet has what it needs, and work continues", "ok");
      onAnswered();
    },
  });

  return (
    <Card tone="warn" padding="var(--s3)">
      <Stack gap="var(--s2)">
        <Row gap="var(--s2)">
          <Dot tone="warn" />
          <strong style={{ color: "var(--warn)" }}>Signet stopped to ask rather than guess</strong>
          <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
            <RelativeTime iso={escalation.raisedAt} />
          </span>
        </Row>
        <p>{escalation.question}</p>
        <TextArea
          value={answer}
          onChange={setAnswer}
          rows={3}
          placeholder="Your answer is added to what you asked for, and work picks up from there."
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

/**
 * What you asked for, read back.
 *
 * This did not exist: the request was write-only. You typed it once, every check
 * was judged against it, and no screen in the console could show it to you — the
 * tab that looked like it did was listing file paths. When a step is blocked, the
 * first question is "what did I actually ask for?", and the answer was nowhere.
 *
 * Versions matter here. Answering a question does not edit the request, it adds a
 * version — so each step records which one it was built from, and a step built
 * before you answered was working from different instructions. That is worth
 * seeing when you are deciding whether a check is being unfair.
 */
function RequestTab({
  briefs,
  increments,
}: {
  briefs: BriefVersionView[];
  increments: IncrementDetail[];
}) {
  const current = briefs[0];
  const earlier = briefs.slice(1);
  const versionById = new Map(briefs.map((b) => [b.id, b.version]));

  if (!current) {
    return (
      <EmptyState
        title="Nothing recorded"
        body="This feature has no saved request, which should not happen — every feature is created with one."
      />
    );
  }

  return (
    <Stack gap="var(--s5)">
      <Understand
        title={briefs.length > 1 ? `Current request · version ${current.version}` : "Your request"}
        meta={
          <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
            saved <RelativeTime iso={current.frozenAt} />
          </span>
        }
      >
        {/* Rendered as written, whitespace preserved. Not parsed as Markdown: a
            renderer is a dependency and a fidelity risk, and showing the text
            exactly as it was typed is the point of this screen. */}
        <Card>
          <div
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              fontSize: "var(--fs-md)",
              lineHeight: 1.65,
            }}
          >
            {current.contentMd}
          </div>
        </Card>
      </Understand>

      {earlier.length > 0 && (
        <Forensics
          id="feature.brief.history"
          label="Earlier versions"
          count={earlier.length}
        >
          <Stack gap="var(--s3)">
            <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
              Each answer you gave to a question was added as a new version rather than
              editing the old one, so nothing you wrote is ever overwritten.
            </span>
            {earlier.map((b) => (
              <Stack key={b.id} gap="var(--s1)">
                <Row gap="var(--s2)">
                  <Badge mono>version {b.version}</Badge>
                  <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
                    <RelativeTime iso={b.frozenAt} />
                  </span>
                </Row>
                <Card padding="var(--s3)">
                  <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--fg-muted)" }}>
                    {b.contentMd}
                  </div>
                </Card>
              </Stack>
            ))}
          </Stack>
        </Forensics>
      )}

      <Understand title="Files each step may change">
        <Card>
          <Stack gap="var(--s3)">
            {increments.map((inc) => {
              const builtFrom = versionById.get(inc.briefVersionId);
              const stale = builtFrom !== undefined && builtFrom !== current.version;
              return (
                <Stack key={inc.id} gap="var(--s1)">
                  <Row gap="var(--s2)" wrap>
                    <strong>{inc.title}</strong>
                    <StateBadge status={inc.state.status} />
                    {/* A step built before you answered a question was working from
                        older instructions. Saying so beats letting someone wonder
                        why it did not follow the latest wording. */}
                    {stale && (
                      <span title={`Built from version ${builtFrom}; the current request is version ${current.version}.`}>
                        <Badge tone="warn">built from version {builtFrom}</Badge>
                      </span>
                    )}
                  </Row>
                  <CodeBlock text={inc.declaredSurface.join("\n") || "(no limit set)"} maxHeight={120} />
                </Stack>
              );
            })}
          </Stack>
        </Card>
        <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
          This is the boundary for each step. Anything changed outside it is caught
          automatically, rather than relying on someone spotting it in review.
        </span>
      </Understand>
    </Stack>
  );
}

/** Every run of every step in this feature — the "what has it tried" question. */
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
                    {r.repairs} retr{r.repairs === 1 ? "y" : "ies"}
                  </Badge>
                )}
                {r.gatesFailed.map((g) => (
                  <Badge key={g} tone="err" mono>
                    {CHECK_NAME[g] ?? g} blocked
                  </Badge>
                ))}
                {r.gatesRepaired.map((g) => (
                  <Badge key={g} tone="ok" mono>
                    {CHECK_NAME[g] ?? g} ✓ fixed
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
