// Runs: cross-feature visibility that did not exist at all before.
//
// Everything used to be scoped to one feature, so questions like "what failed
// today", "which runs needed repair attempts" and "where did the tokens go" had
// no answer anywhere in the product. Clicking a row opens the inspector rather
// than navigating, so the list, its filter and its scroll position survive.

import { useQuery } from "@tanstack/react-query";
import type { RunSummary } from "@signet/contracts";
import { api } from "../api.js";
import { navigate, type Route } from "../router.js";
import { Badge, Button, Card, Detail, Dot, Row, Segmented, Stack } from "../ui/primitives.js";
import { Drawer, EmptyState, QueryState } from "../ui/feedback.js";
import { Forensics, Understand } from "../ui/tiers.js";
import { DataTable, type Column } from "../ui/table.js";
import {
  CodeBlock,
  Duration,
  Id,
  LiveDuration,
  Money,
  RelativeTime,
  RUN_OUTCOME,
  TokenCount,
} from "../ui/format.js";

const OUTCOMES = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "aborted", label: "Aborted" },
] as const;

export function Runs({ route }: { route: Extract<Route, { view: "runs" }> }) {
  const outcome = route.outcome ?? "all";
  const q = useQuery({
    queryKey: ["runs", outcome],
    queryFn: () => api.runs({ outcome, limit: 200 }),
    refetchInterval: 5000,
  });

  const columns: Column<RunSummary>[] = [
    {
      key: "outcome",
      header: "Outcome",
      width: "120px",
      sort: (a, b) => a.outcome.localeCompare(b.outcome),
      render: (r) => {
        const o = RUN_OUTCOME[r.outcome] ?? { label: r.outcome, tone: "neutral" as const };
        return (
          <Badge tone={o.tone}>
            <Dot tone={o.tone} pulse={r.outcome === "running"} />
            {o.label}
          </Badge>
        );
      },
    },
    {
      key: "what",
      header: "Increment",
      sort: (a, b) => a.incrementTitle.localeCompare(b.incrementTitle),
      render: (r) => (
        <Stack gap="1px" style={{ minWidth: 0 }}>
          <span style={{ fontWeight: 500 }}>{r.incrementTitle}</span>
          <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>{r.featureTitle}</span>
        </Stack>
      ),
    },
    {
      key: "gates",
      header: "Gates",
      width: "190px",
      render: (r) =>
        r.gatesFailed.length === 0 && r.gatesRepaired.length === 0 ? (
          <span style={{ color: "var(--fg-subtle)" }}>clean</span>
        ) : (
          <Row gap="var(--s1)" wrap>
            {r.gatesFailed.map((g) => (
              <span key={g} title={`${g} was still failing in the final round — this is what blocked`}>
                <Badge tone="err" mono>
                  {g}
                </Badge>
              </span>
            ))}
            {/* A gate that failed and was then fixed is the gate doing its job.
                Showing it in the same red as a blocker would make every
                successful repair read as a defect. */}
            {r.gatesRepaired.map((g) => (
              <span key={g} title={`${g} failed, the agent was given the findings, and it passed on a later round`}>
                <Badge tone="ok" mono>
                  {g} ✓ repaired
                </Badge>
              </span>
            ))}
          </Row>
        ),
    },
    {
      key: "repair",
      header: "Repairs",
      width: "90px",
      align: "right",
      sort: (a, b) => a.repairs - b.repairs,
      render: (r) =>
        r.repairs > 0 ? (
          <span title={`The gate suite ran ${r.gateRounds} times`}>
            <Badge tone="warn" mono>
              {r.repairs}
            </Badge>
          </span>
        ) : (
          <span style={{ color: "var(--fg-subtle)" }}>0</span>
        ),
    },
    {
      key: "duration",
      header: "Duration",
      width: "110px",
      align: "right",
      sort: (a, b) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity),
      render: (r) => (r.durationMs === null ? <LiveDuration since={r.startedAt} /> : <Duration ms={r.durationMs} />),
    },
    {
      key: "tokens",
      header: "Tokens",
      width: "120px",
      align: "right",
      sort: (a, b) => a.inputTokens + a.outputTokens - (b.inputTokens + b.outputTokens),
      render: (r) => (
        <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
          <TokenCount n={r.inputTokens} /> / <TokenCount n={r.outputTokens} />
        </span>
      ),
    },
    {
      key: "cost",
      header: "Cost",
      width: "90px",
      align: "right",
      sort: (a, b) => (a.costUsd ?? -1) - (b.costUsd ?? -1),
      render: (r) => <Money usd={r.costUsd} />,
    },
    {
      key: "when",
      header: "Started",
      width: "110px",
      align: "right",
      sort: (a, b) => a.startedAt.localeCompare(b.startedAt),
      render: (r) => (
        <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
          <RelativeTime iso={r.startedAt} />
        </span>
      ),
    },
  ];

  return (
    <Stack gap="var(--s4)">
      <Row justify="space-between" wrap gap="var(--s3)">
        <Segmented
          options={OUTCOMES}
          value={outcome}
          onChange={(v) => navigate({ view: "runs", outcome: v })}
        />
        <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
          {q.data ? `${q.data.length} run${q.data.length === 1 ? "" : "s"}` : ""} · newest first · click a row to inspect
        </span>
      </Row>

      <QueryState isPending={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeletonRows={6}>
        <DataTable
          rows={q.data ?? []}
          columns={columns}
          rowKey={(r) => r.id}
          selectedKey={route.selected ?? null}
          onOpen={(r) => navigate({ view: "runs", outcome, selected: r.id })}
          initialSort={{ key: "when", dir: "desc" }}
          empty={
            <EmptyState
              title={outcome === "all" ? "No runs yet" : `No ${outcome} runs`}
              body={
                outcome === "all"
                  ? "A run is one attempt at one increment. Approve an increment to start the first."
                  : "Try a different outcome filter."
              }
            />
          }
        />
      </QueryState>

      <RunInspector
        runId={route.selected ?? null}
        onClose={() => navigate({ view: "runs", outcome })}
      />
    </Stack>
  );
}

/**
 * The full anatomy of one run. This is the screen that answers "what actually
 * happened", so it shows the phase timeline with durations — where the time went
 * is usually the question behind the question.
 */
function RunInspector({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId as string),
    enabled: runId !== null,
    refetchInterval: 4000,
  });

  const d = q.data;
  const o = d ? (RUN_OUTCOME[d.summary.outcome] ?? { label: d.summary.outcome, tone: "neutral" as const }) : null;
  const slowest = d ? Math.max(1, ...d.phases.map((p) => p.durationMs ?? 0)) : 1;

  return (
    <Drawer
      open={runId !== null}
      onClose={onClose}
      title={d ? d.summary.incrementTitle : "Run"}
      subtitle={d ? d.summary.featureTitle : undefined}
      width={780}
    >
      <QueryState isPending={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeletonRows={4}>
        {d && o && (
          <Stack gap="var(--s5)">
            <Row gap="var(--s5)" wrap>
              <Detail label="Outcome">
                <Badge tone={o.tone}>
                  <Dot tone={o.tone} pulse={d.summary.outcome === "running"} />
                  {o.label}
                </Badge>
              </Detail>
              <Detail label="Duration">
                {d.summary.durationMs === null ? (
                  <LiveDuration since={d.summary.startedAt} />
                ) : (
                  <Duration ms={d.summary.durationMs} />
                )}
              </Detail>
              <Detail label="Started">
                <RelativeTime iso={d.summary.startedAt} />
              </Detail>
              <Detail label="Repairs">
                <span className="num" title={`The gate suite ran ${d.summary.gateRounds} time(s)`}>
                  {d.summary.repairs}
                </span>
              </Detail>
              <Detail label="Cost">
                <Money usd={d.summary.costUsd} />
              </Detail>
              <Detail label="Run id">
                <Id value={d.summary.id} label="run" />
              </Detail>
            </Row>

            <Understand title="Where the time went">
              <Card padding="var(--s3)">
                <Stack gap="var(--s2)">
                  {d.phases.map((p, i) => (
                    <Row key={`${p.phase}-${p.attempt}-${i}`} gap="var(--s3)">
                      <span style={{ width: 130, fontFamily: "var(--mono)", fontSize: "var(--fs-sm)" }}>
                        {p.phase.toLowerCase()}
                        {p.attempt > 1 && <span style={{ color: "var(--warn)" }}> #{p.attempt}</span>}
                      </span>
                      {/* Bars relative to the slowest phase: the shape of where
                          time went is more useful than the raw numbers alone. */}
                      <span
                        style={{
                          flex: 1,
                          height: 6,
                          background: "var(--panel-3)",
                          borderRadius: "var(--r-full)",
                          overflow: "hidden",
                          minWidth: 60,
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            height: "100%",
                            width: `${Math.max(2, ((p.durationMs ?? 0) / slowest) * 100)}%`,
                            background: p.completedAt === null ? "var(--run)" : "var(--accent)",
                          }}
                        />
                      </span>
                      <span style={{ width: 70, textAlign: "right", color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
                        {p.completedAt === null ? <LiveDuration since={p.enteredAt} /> : <Duration ms={p.durationMs} />}
                      </span>
                    </Row>
                  ))}
                  {d.phases.length === 0 && <span style={{ color: "var(--fg-subtle)" }}>No phases recorded.</span>}
                </Stack>
              </Card>
            </Understand>

            {d.usageByModel.length > 0 && (
              <Understand title="Model usage">
                <Card padding="var(--s3)">
                  <Stack gap="var(--s2)">
                    {d.usageByModel.map((u) => (
                      <Row key={u.model} justify="space-between" wrap gap="var(--s3)">
                        <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-sm)" }}>{u.model}</span>
                        <Row gap="var(--s4)" style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
                          <span>{u.calls} calls</span>
                          <span>
                            in <TokenCount n={u.inputTokens} /> ({<TokenCount n={u.cachedInputTokens} />} cached)
                          </span>
                          <span>
                            out <TokenCount n={u.outputTokens} />
                          </span>
                          <Money usd={u.costUsd} />
                        </Row>
                      </Row>
                    ))}
                  </Stack>
                </Card>
              </Understand>
            )}

            {d.effects.length > 0 && (
              <Forensics id={`run.effects.${d.summary.id}`} label="Journalled effects" count={d.effects.length}>
                <Card padding="var(--s3)">
                  <Stack gap="var(--s1)">
                    {d.effects.map((e) => (
                      <Row key={e.idempotencyKey} justify="space-between" gap="var(--s3)">
                        <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-sm)" }}>
                          {e.phase.toLowerCase()} · {e.kind}
                        </span>
                        <Badge tone={e.status === "DONE" ? "ok" : e.status === "FAILED" ? "err" : "idle"} mono>
                          {e.status.toLowerCase()}
                        </Badge>
                      </Row>
                    ))}
                  </Stack>
                </Card>
                <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
                  Each effect is keyed so a replay after a crash cannot perform it twice.
                </span>
              </Forensics>
            )}

            {/* Raw state, session ref and workspace path: the things you want at 2am
                once a year, and clutter on every other visit. */}
            <Forensics id={`run.raw.${d.summary.id}`} label="Raw state, session and workspace">
              <Stack gap="var(--s3)">
                <CodeBlock text={prettyJson(d.stateJson)} maxHeight={200} />
                <Row gap="var(--s5)" wrap>
                  <Detail label="Session" mono>
                    {d.sessionRef ?? "—"}
                  </Detail>
                  <Detail label="Workspace" mono>
                    {d.workspacePath ?? "—"}
                  </Detail>
                </Row>
              </Stack>
            </Forensics>

            <Button onClick={() => navigate({ view: "feature", id: d.summary.featureId })}>
              Open the feature →
            </Button>
          </Stack>
        )}
      </QueryState>
    </Drawer>
  );
}

/** Pretty-print if it parses; show it verbatim if it does not. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2); // signet-policy-allow: raw-json-parse -- display only, failure falls through
  } catch {
    return raw;
  }
}
