// Overview: is the system healthy, what needs me, what is running, what has it
// cost.
//
// The needs-you queue is first and actionable, because the product's promise is
// "one interrogation, two signatures" — and if the signatures are slow to reach,
// the promise is broken no matter how good the runtime is. Everything else on this
// screen is there to be glanced at, not studied.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AttentionItem } from "@signet/contracts";
import { api } from "../api.js";
import { navigate } from "../router.js";
import { Badge, Button, Card, Detail, Dot, Meter, Row, SectionTitle, Stack, type Tone } from "../ui/primitives.js";
import { ConfirmButton, EmptyState, QueryState, useToast } from "../ui/feedback.js";
import { LiveDuration, Money, RelativeTime, TokenCount } from "../ui/format.js";

const REASON: Record<AttentionItem["reason"], { label: string; tone: Tone; cta: string }> = {
  awaiting_approval: { label: "Needs signature 1", tone: "accent", cta: "Review & start" },
  awaiting_merge: { label: "Needs signature 2", tone: "warn", cta: "Review & merge" },
  question_raised: { label: "Question raised", tone: "warn", cta: "Answer" },
  failed: { label: "Failed", tone: "err", cta: "Inspect" },
};

export function Overview() {
  const q = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 5000 });

  return (
    <QueryState isPending={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeletonRows={4}>
      {q.data && <Loaded data={q.data} />}
    </QueryState>
  );
}

function Loaded({ data }: { data: Awaited<ReturnType<typeof api.overview>> }) {
  const { counts, attention, activeRuns, spend, reliability, quota, dispatcher } = data;
  const window24 = spend[0];
  const passRate =
    reliability.sample === 0 ? null : Math.round((reliability.succeeded / reliability.sample) * 100);

  return (
    <Stack gap="var(--s6)">
      <Stack gap="var(--s3)">
        <Row gap="var(--s3)" wrap>
          <Stat label="Needs you" value={String(attention.length)} tone={attention.length > 0 ? "warn" : "ok"} />
          <Stat label="Running now" value={String(activeRuns.length)} tone={activeRuns.length > 0 ? "run" : "idle"} />
          <Stat
            label="Merged"
            value={`${counts.incrementsMerged}/${counts.incrementsTotal}`}
            tone="ok"
            meter={{ value: counts.incrementsMerged, max: counts.incrementsTotal }}
          />
          <Stat
            label="Blocked"
            value={String(counts.incrementsBlocked)}
            tone={counts.incrementsBlocked > 0 ? "err" : "idle"}
          />
          <Stat
            label="Pass rate"
            value={passRate === null ? "—" : `${passRate}%`}
            hint={reliability.sample === 0 ? "no finished runs yet" : `last ${reliability.sample} runs`}
            tone={passRate === null ? "idle" : passRate >= 70 ? "ok" : passRate >= 40 ? "warn" : "err"}
          />
          {window24 && (
            <Stat
              label="Spend, 24h"
              value={<Money usd={window24.costUsd} />}
              hint={`${window24.runs} run${window24.runs === 1 ? "" : "s"}`}
              tone="neutral"
            />
          )}
        </Row>
        <PipelineControl dispatcher={dispatcher} quotaExhausted={quota.exhausted} quotaResetsAt={quota.resetsAt} />
      </Stack>

      <Stack gap="var(--s3)">
        <SectionTitle
          action={
            attention.length > 0 ? (
              <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>oldest first</span>
            ) : undefined
          }
        >
          Needs you
        </SectionTitle>
        {attention.length === 0 ? (
          <EmptyState
            title="Nothing is waiting on you"
            body="Every increment is either running, merged, or parked until the quota window resets."
          />
        ) : (
          <Stack gap="var(--s2)">
            {attention.map((item) => (
              <AttentionRow key={item.incrementId} item={item} />
            ))}
          </Stack>
        )}
      </Stack>

      {activeRuns.length > 0 && (
        <Stack gap="var(--s3)">
          <SectionTitle>Running now</SectionTitle>
          <Stack gap="var(--s2)">
            {activeRuns.map((r) => (
              <Card key={r.runId} padding="var(--s3)">
                <Row justify="space-between" wrap gap="var(--s3)">
                  <Row gap="var(--s2)">
                    <Dot tone="run" pulse />
                    <a href={`#/work/${r.featureId}`} style={{ fontWeight: 500 }}>
                      {r.incrementTitle}
                    </a>
                    <Badge tone="run" mono>
                      {r.phase.toLowerCase()}
                      {r.attempt > 1 ? ` · attempt ${r.attempt}` : ""}
                    </Badge>
                  </Row>
                  <Row gap="var(--s4)" style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
                    <span>
                      in this phase <LiveDuration since={r.phaseEnteredAt} />
                    </span>
                    <span>
                      total <LiveDuration since={r.startedAt} />
                    </span>
                  </Row>
                </Row>
              </Card>
            ))}
          </Stack>
        </Stack>
      )}

      <Stack gap="var(--s3)">
        <SectionTitle
          action={
            <Button size="sm" variant="quiet" onClick={() => navigate({ view: "runs" })}>
              all runs →
            </Button>
          }
        >
          Spend and throughput
        </SectionTitle>
        <Card padding="0">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--fs)" }}>
            <thead>
              <tr style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)", textTransform: "uppercase" }}>
                <th style={{ textAlign: "left", padding: "var(--s2) var(--s3)" }}>Window</th>
                <th style={{ textAlign: "right", padding: "var(--s2) var(--s3)" }}>Runs</th>
                <th style={{ textAlign: "right", padding: "var(--s2) var(--s3)" }}>In</th>
                <th style={{ textAlign: "right", padding: "var(--s2) var(--s3)" }}>Cached</th>
                <th style={{ textAlign: "right", padding: "var(--s2) var(--s3)" }}>Out</th>
                <th style={{ textAlign: "right", padding: "var(--s2) var(--s3)" }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {spend.map((w, i) => (
                <tr key={w.label} style={{ borderTop: i === 0 ? "1px solid var(--line)" : "1px solid var(--line)" }}>
                  <td style={{ padding: "var(--s2) var(--s3)" }}>{w.label}</td>
                  <td style={{ padding: "var(--s2) var(--s3)", textAlign: "right" }} className="num">
                    {w.runs}
                  </td>
                  <td style={{ padding: "var(--s2) var(--s3)", textAlign: "right" }}>
                    <TokenCount n={w.inputTokens} />
                  </td>
                  <td style={{ padding: "var(--s2) var(--s3)", textAlign: "right", color: "var(--fg-muted)" }}>
                    <TokenCount n={w.cachedInputTokens} />
                  </td>
                  <td style={{ padding: "var(--s2) var(--s3)", textAlign: "right" }}>
                    <TokenCount n={w.outputTokens} />
                  </td>
                  <td style={{ padding: "var(--s2) var(--s3)", textAlign: "right" }}>
                    <Money usd={w.costUsd} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Row gap="var(--s4)" wrap style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
          <span>
            Of the last {reliability.sample} finished runs: {reliability.succeeded} succeeded,{" "}
            {reliability.failed} failed, {reliability.aborted} aborted.
          </span>
        </Row>
      </Stack>
    </Stack>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "neutral",
  meter,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: Tone;
  meter?: { value: number; max: number };
}) {
  return (
    <Card padding="var(--s3)" style={{ flex: "1 1 150px", minWidth: 140 }}>
      <Stack gap="var(--s1)">
        <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {label}
        </span>
        <Row gap="var(--s2)">
          {tone !== "neutral" && <Dot tone={tone} />}
          <span style={{ fontSize: "var(--fs-xl)", fontWeight: 600 }} className="num">
            {value}
          </span>
        </Row>
        {meter && <Meter value={meter.value} max={meter.max} tone={tone} />}
        {hint && <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)" }}>{hint}</span>}
      </Stack>
    </Card>
  );
}

/**
 * The pipeline hold, where it can be seen and reached. Pausing is the operator's
 * emergency brake, so it should never be more than one click away — and it states
 * exactly what it does, because "pause" could plausibly mean kill.
 */
function PipelineControl({
  dispatcher,
  quotaExhausted,
  quotaResetsAt,
}: {
  dispatcher: { paused: boolean; maxWorkers: number; activeWorkers: number };
  quotaExhausted: boolean;
  quotaResetsAt?: string | undefined;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const mut = useMutation({
    mutationFn: api.setDispatcher,
    onSuccess: (s) => {
      toast.push(
        s.paused ? "Pipeline paused — in-flight runs finish, nothing new starts" : "Pipeline resumed",
        s.paused ? "warn" : "ok",
      );
      void qc.invalidateQueries({ queryKey: ["overview"] });
      void qc.invalidateQueries({ queryKey: ["dispatcher"] });
    },
    onError: (e) => toast.push(`Could not change the dispatcher: ${String(e)}`, "err"),
  });

  return (
    <Card tone={dispatcher.paused ? "warn" : "neutral"} padding="var(--s3)">
      <Row justify="space-between" wrap gap="var(--s3)">
        <Row gap="var(--s5)" wrap>
          <Detail label="Pipeline">
            <Row gap="var(--s2)">
              <Dot tone={dispatcher.paused ? "warn" : "ok"} />
              {dispatcher.paused ? "Paused" : "Running"}
            </Row>
          </Detail>
          <Detail label="Workers">
            <span className="num">
              {dispatcher.activeWorkers} / {dispatcher.maxWorkers}
            </span>
          </Detail>
          <Detail label="Quota window">
            {quotaExhausted ? (
              <Row gap="var(--s2)">
                <Dot tone="err" />
                exhausted
                {quotaResetsAt && (
                  <span style={{ color: "var(--fg-muted)" }}>
                    · resets <RelativeTime iso={quotaResetsAt} />
                  </span>
                )}
              </Row>
            ) : (
              <Row gap="var(--s2)">
                <Dot tone="ok" />
                healthy
              </Row>
            )}
          </Detail>
        </Row>
        <Row gap="var(--s2)">
          <Button
            size="sm"
            disabled={mut.isPending || dispatcher.maxWorkers <= 1}
            onClick={() => mut.mutate({ maxWorkers: dispatcher.maxWorkers - 1 })}
            title="Lower the worker ceiling. Running workers are never interrupted."
          >
            −
          </Button>
          <Button
            size="sm"
            disabled={mut.isPending || dispatcher.maxWorkers >= 16}
            onClick={() => mut.mutate({ maxWorkers: dispatcher.maxWorkers + 1 })}
            title="Raise the worker ceiling"
          >
            +
          </Button>
          {dispatcher.paused ? (
            <Button variant="primary" disabled={mut.isPending} onClick={() => mut.mutate({ paused: false })}>
              Resume pipeline
            </Button>
          ) : (
            <ConfirmButton
              variant="danger"
              question="In-flight runs will finish; nothing new will start."
              confirmLabel="Pause it"
              disabled={mut.isPending}
              onConfirm={() => mut.mutate({ paused: true })}
            >
              Pause pipeline
            </ConfirmButton>
          )}
        </Row>
      </Row>
    </Card>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const r = REASON[item.reason];
  return (
    <Card tone={r.tone} padding="var(--s3)">
      <Row justify="space-between" wrap gap="var(--s3)">
        <Stack gap="var(--s1)" style={{ minWidth: 0 }}>
          <Row gap="var(--s2)" wrap>
            <Badge tone={r.tone}>{r.label}</Badge>
            <strong>{item.incrementTitle}</strong>
            <span style={{ color: "var(--fg-subtle)" }}>in {item.featureTitle}</span>
          </Row>
          <span style={{ color: "var(--fg-muted)" }}>{item.detail}</span>
        </Stack>
        <Row gap="var(--s3)">
          <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
            waiting <RelativeTime iso={item.since} />
          </span>
          <Button variant="primary" size="sm" onClick={() => navigate({ view: "feature", id: item.featureId })}>
            {r.cta}
          </Button>
        </Row>
      </Row>
    </Card>
  );
}
