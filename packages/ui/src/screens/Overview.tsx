// Overview: what needs you, then everything else.
//
// This screen used to present six equal stat cards, a large pipeline-control card, a
// queue, a running list, and a full spend table — all at the same visual weight. Nine
// co-equal blocks is not an overview, it is an inventory, and an operator scanning
// for "what needs me" had to read the whole page to find it.
//
// Now it has one subject. The needs-you queue is the focal section; everything else
// is subordinate or disclosed. Two rules do the work:
//
//   · One focal metric per screen, at a size nothing else competes with.
//   · Controls surface themselves by urgency. A paused pipeline is the most
//     expensive thing to not notice, so it becomes a banner at the top. When it is
//     healthy it is a quiet line near the bottom, because nobody needs to be told
//     that things are working.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AttentionItem } from "@signet/contracts";
import { api } from "../api.js";
import { navigate } from "../router.js";
import { Button, Card, Dot, Row, Stack, type Tone } from "../ui/primitives.js";
import { ConfirmButton, EmptyState, QueryState, useToast } from "../ui/feedback.js";
import { Decide, FocalMetric, Forensics, MetricStrip, RowDivider, Understand } from "../ui/tiers.js";
import { LiveDuration, Money, RelativeTime, TokenCount } from "../ui/format.js";

const REASON: Record<AttentionItem["reason"], { label: string; tone: Tone; cta: string }> = {
  awaiting_approval: { label: "Start it", tone: "accent", cta: "Review & start" },
  awaiting_merge: { label: "Merge it", tone: "warn", cta: "Review & merge" },
  question_raised: { label: "Answer it", tone: "warn", cta: "Answer" },
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
  const held = dispatcher.paused || quota.exhausted;

  return (
    <Stack gap="var(--s8)">
      {/* Urgent only. A healthy pipeline says nothing here. */}
      {held && <HeldBanner dispatcher={dispatcher} quota={quota} />}

      <Decide
        title="Needs you"
        meta={
          attention.length > 0 ? (
            <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>oldest first</span>
          ) : undefined
        }
      >
        <FocalMetric
          label={attention.length === 1 ? "thing is waiting on you" : "things are waiting on you"}
          value={attention.length}
          tone={attention.length > 0 ? "var(--warn)" : "var(--ok)"}
          {...(attention[0] ? { hint: `longest since ${new Date(attention[0].since).toLocaleTimeString()}` } : {})}
        />

        {attention.length === 0 ? (
          <EmptyState
            title="Nothing is waiting on you"
            body="Every increment is running, merged, or parked until the quota window resets."
          />
        ) : (
          /* Hairline rows in one surface, not a card each — a stack of equal boxes is
             what made this screen read as machine-built. */
          <Card padding="0">
            {attention.map((item, i) => (
              <div key={item.incrementId}>
                {i > 0 && <RowDivider />}
                <AttentionRow item={item} />
              </div>
            ))}
          </Card>
        )}
      </Decide>

      {activeRuns.length > 0 && (
        <Understand title={activeRuns.length === 1 ? "Running now" : `Running now · ${activeRuns.length}`}>
          <Card padding="0">
            {activeRuns.map((r, i) => (
              <div key={r.runId}>
                {i > 0 && <RowDivider />}
                <Row justify="space-between" wrap gap="var(--s3)" style={{ padding: "var(--s3)" }}>
                  <Row gap="var(--s2)" style={{ minWidth: 0 }}>
                    <Dot tone="run" pulse />
                    <a href={`#/work/${r.featureId}`}>{r.incrementTitle}</a>
                    <span style={{ color: "var(--fg-subtle)", fontFamily: "var(--mono)", fontSize: "var(--fs-sm)" }}>
                      {r.phase.toLowerCase()}
                      {r.attempt > 1 ? ` · attempt ${r.attempt}` : ""}
                    </span>
                  </Row>
                  <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
                    <LiveDuration since={r.startedAt} />
                  </span>
                </Row>
              </div>
            ))}
          </Card>
        </Understand>
      )}

      <Understand
        title="Delivery"
        meta={
          <Button size="sm" variant="quiet" onClick={() => navigate({ view: "runs" })}>
            all runs →
          </Button>
        }
      >
        <MetricStrip
          items={[
            {
              label: "Merged",
              value: `${counts.incrementsMerged}/${counts.incrementsTotal}`,
              ...(counts.incrementsBlocked > 0 ? { hint: `${counts.incrementsBlocked} blocked` } : {}),
            },
            {
              label: "Pass rate",
              value: passRate === null ? "—" : `${passRate}%`,
              hint: reliability.sample === 0 ? "no finished runs" : `last ${reliability.sample}`,
            },
            ...(window24
              ? [
                  {
                    label: "Spend, 24h",
                    value: <Money usd={window24.costUsd} />,
                    hint: `${window24.runs} run${window24.runs === 1 ? "" : "s"}`,
                  },
                ]
              : []),
          ]}
        />

        {/* The full window table is reference data, not glance data. */}
        <Forensics id="overview.spend" label="Spend by window" count={spend.length}>
          <Card padding="0">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--fs)" }}>
              <thead>
                <tr style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)" }}>
                  <th style={{ textAlign: "left", padding: "var(--s2) var(--s3)", fontWeight: 400 }}>Window</th>
                  <th style={{ textAlign: "right", padding: "var(--s2) var(--s3)", fontWeight: 400 }}>Runs</th>
                  <th style={{ textAlign: "right", padding: "var(--s2) var(--s3)", fontWeight: 400 }}>In</th>
                  <th style={{ textAlign: "right", padding: "var(--s2) var(--s3)", fontWeight: 400 }}>Cached</th>
                  <th style={{ textAlign: "right", padding: "var(--s2) var(--s3)", fontWeight: 400 }}>Out</th>
                  <th style={{ textAlign: "right", padding: "var(--s2) var(--s3)", fontWeight: 400 }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {spend.map((w) => (
                  <tr key={w.label} style={{ borderTop: "1px solid var(--line)" }}>
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
          <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
            Of the last {reliability.sample} finished runs: {reliability.succeeded} succeeded,{" "}
            {reliability.failed} failed, {reliability.aborted} aborted.
          </span>
        </Forensics>
      </Understand>

      {/* Quiet when healthy. The banner above takes over when it is not. */}
      {!held && <PipelineLine dispatcher={dispatcher} />}
    </Stack>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const r = REASON[item.reason];
  return (
    <Row justify="space-between" wrap gap="var(--s3)" style={{ padding: "var(--s3)" }}>
      <Row gap="var(--s3)" style={{ minWidth: 0 }}>
        <Dot tone={r.tone} />
        <Stack gap="2px" style={{ minWidth: 0 }}>
          <Row gap="var(--s2)" wrap>
            <span>{item.incrementTitle}</span>
            <span style={{ color: "var(--fg-subtle)" }}>{item.featureTitle}</span>
          </Row>
          <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>{item.detail}</span>
        </Stack>
      </Row>
      <Row gap="var(--s3)" style={{ flex: "0 0 auto" }}>
        <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
          <RelativeTime iso={item.since} />
        </span>
        <Button size="sm" onClick={() => navigate({ view: "feature", id: item.featureId })}>
          {r.cta}
        </Button>
      </Row>
    </Row>
  );
}

/** Shown only when the pipeline is held — the state that is expensive to miss. */
function HeldBanner({
  dispatcher,
  quota,
}: {
  dispatcher: { paused: boolean; maxWorkers: number; activeWorkers: number };
  quota: { exhausted: boolean; resetsAt?: string | undefined };
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const mut = useMutation({
    mutationFn: api.setDispatcher,
    onSuccess: (s) => {
      toast.push(s.paused ? "Pipeline paused" : "Pipeline resumed", s.paused ? "warn" : "ok");
      void qc.invalidateQueries({ queryKey: ["overview"] });
      void qc.invalidateQueries({ queryKey: ["dispatcher"] });
    },
    onError: (e) => toast.push(`Could not change the dispatcher: ${String(e)}`, "err"),
  });

  return (
    <Card tone={dispatcher.paused ? "warn" : "err"} padding="var(--s3)">
      <Row justify="space-between" wrap gap="var(--s3)">
        <Row gap="var(--s2)" style={{ minWidth: 0 }}>
          <Dot tone={dispatcher.paused ? "warn" : "err"} />
          <Stack gap="2px">
            <span>{dispatcher.paused ? "The pipeline is paused" : "The quota window is exhausted"}</span>
            <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
              {dispatcher.paused
                ? "Nothing new will start. In-flight runs finish normally, and this survives a restart."
                : quota.resetsAt
                  ? `Work is parked and resumes by itself when the window resets ${new Date(quota.resetsAt).toLocaleTimeString()}.`
                  : "Work is parked and resumes by itself when the window resets."}
            </span>
          </Stack>
        </Row>
        {dispatcher.paused && (
          <Button variant="primary" disabled={mut.isPending} onClick={() => mut.mutate({ paused: false })}>
            Resume
          </Button>
        )}
      </Row>
    </Card>
  );
}

/** The healthy-state control: reachable in one click, shouting at nobody. */
function PipelineLine({
  dispatcher,
}: {
  dispatcher: { paused: boolean; maxWorkers: number; activeWorkers: number };
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const mut = useMutation({
    mutationFn: api.setDispatcher,
    onSuccess: (s) => {
      toast.push(
        s.paused ? "Pipeline paused — in-flight runs finish, nothing new starts" : "Worker ceiling changed",
        s.paused ? "warn" : "ok",
      );
      void qc.invalidateQueries({ queryKey: ["overview"] });
      void qc.invalidateQueries({ queryKey: ["dispatcher"] });
    },
    onError: (e) => toast.push(`Could not change the dispatcher: ${String(e)}`, "err"),
  });

  return (
    <Row
      justify="space-between"
      wrap
      gap="var(--s3)"
      style={{ borderTop: "1px solid var(--line)", paddingTop: "var(--s3)" }}
    >
      <Row gap="var(--s3)" style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
        <Row gap="var(--s2)">
          <Dot tone="ok" />
          Pipeline running
        </Row>
        <span className="num">
          {dispatcher.activeWorkers}/{dispatcher.maxWorkers} workers
        </span>
      </Row>
      <Row gap="var(--s2)">
        <Button
          size="sm"
          variant="quiet"
          disabled={mut.isPending || dispatcher.maxWorkers <= 1}
          onClick={() => mut.mutate({ maxWorkers: dispatcher.maxWorkers - 1 })}
          title="Lower the worker ceiling. Running workers are never interrupted."
        >
          −
        </Button>
        <Button
          size="sm"
          variant="quiet"
          disabled={mut.isPending || dispatcher.maxWorkers >= 16}
          onClick={() => mut.mutate({ maxWorkers: dispatcher.maxWorkers + 1 })}
          title="Raise the worker ceiling"
        >
          +
        </Button>
        <ConfirmButton
          variant="danger"
          question="In-flight runs finish; nothing new starts."
          confirmLabel="Pause it"
          disabled={mut.isPending}
          onConfirm={() => mut.mutate({ paused: true })}
        >
          Pause pipeline
        </ConfirmButton>
      </Row>
    </Row>
  );
}

