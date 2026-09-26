// What is happening right now, while it is happening.
//
// The gap this closes: you clicked "Approve and start", the badge changed to
// "Working", and then nothing moved for several minutes. Everything needed to show
// otherwise was already being recorded — phases with timestamps, attempt numbers,
// token counts, spend, gate verdicts as they land — it just was not on screen
// until the run was over. So a run that was progressing normally and a run that
// had wedged looked exactly the same, and the only way to tell them apart was to
// wait.
//
// Two decisions worth stating:
//
//   · The elapsed time ticks locally, once a second, instead of only updating when
//     the server pushes. A number that visibly moves is the difference between
//     "this is alive" and "this might be stuck", and that reassurance is the whole
//     point of the panel. It is derived from the phase's own enteredAt, so the tick
//     is presentation, never a second source of truth.
//   · Spend is shown while it accrues, not just at the end. Finding out what a run
//     cost after it finished is an invoice; seeing it climb is a control.

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GateVerdictView } from "@signet/contracts";
import { api } from "../api.js";
import { Money, formatCount, formatDuration, GateBadge } from "./format.js";
import { Row, Stack } from "./primitives.js";

/** The gates we expect to see, in the order they are reported. */
const EXPECTED_GATES = ["typecheck", "lint", "tests", "conformance", "rules"] as const;

/** Phase names the runtime uses, in the plain words the panel says. */
const PHASE_WORDS: Record<string, string> = {
  PREPARE: "Setting up a clean copy of your repo",
  CONTEXT: "Gathering what the agent needs to know",
  AGENT_IMPLEMENT: "Writing the code",
  GATES: "Running the checks",
  FINALISE: "Wrapping up",
};

/** Ticks every second while `active`, so elapsed time visibly moves. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export interface LiveRunProps {
  runId: string;
  /** Verdicts already known from the increment view, so gates show before the fetch lands. */
  verdicts?: GateVerdictView[];
}

/**
 * The live panel for one in-flight run. Returns null rather than a spinner while
 * the first fetch is in flight: the card around it already says the step is
 * working, and a skeleton that appears and vanishes is more distracting than a
 * panel that simply arrives.
 */
export function LiveRun({ runId, verdicts = [] }: LiveRunProps): ReactNode {
  // The WebSocket invalidates this query on run events, so the refetch interval is
  // a backstop for a dropped socket rather than the primary freshness mechanism.
  const detail = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId),
    refetchInterval: 5000,
  });

  const running = detail.data?.summary.outcome === "running";
  const now = useNow(running);

  if (!detail.data) return null;

  const { summary, phases, usageByModel } = detail.data;
  // The phase with no completedAt is the one we are in. There should be exactly
  // one; if the run has finished there is none, and the panel says so rather than
  // implying work is still happening.
  const current = phases.find((p) => p.completedAt === null);
  const elapsedMs = current ? Math.max(0, now - Date.parse(current.enteredAt)) : null;
  const totalMs = summary.durationMs ?? Math.max(0, now - Date.parse(summary.startedAt));
  const calls = usageByModel.reduce((n, m) => n + m.calls, 0);

  const byGate = new Map(verdicts.map((v) => [v.gate, v]));
  const inGates = current?.phase === "GATES";

  return (
    <Stack
      gap="var(--s3)"
      style={{
        border: "1px solid var(--accent-line)",
        background: "var(--accent-quiet)",
        borderRadius: "var(--r-sm)",
        padding: "var(--s3)",
      }}
    >
      <Row justify="space-between" wrap gap="var(--s2)">
        <Row gap="var(--s2)" style={{ minWidth: 0 }}>
          {running && <Pulse />}
          <span style={{ fontWeight: 500 }}>
            {current ? (PHASE_WORDS[current.phase] ?? current.phase) : "Finishing"}
          </span>
          {current && current.attempt > 1 && (
            <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
              attempt {current.attempt}
            </span>
          )}
        </Row>
        {elapsedMs !== null && (
          <span
            style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-sm)", color: "var(--fg-muted)" }}
            // Announced politely so a screen reader is not interrupted every second.
            aria-live="off"
          >
            {formatDuration(elapsedMs)} in this step · {formatDuration(totalMs)} total
          </span>
        )}
      </Row>

      {/* The checks, individually, as they land. A single "Checking" badge cannot
          distinguish "conformance is still running" from "conformance passed and
          tests are slow", which is exactly what you want to know while waiting. */}
      {inGates && (
        <Row gap="var(--s1)" wrap>
          {EXPECTED_GATES.map((gate) => {
            const v = byGate.get(gate);
            return (
              <GateBadge
                key={gate}
                gate={gate}
                outcome={v?.outcome ?? "running"}
                count={v?.findings.length ?? 0}
              />
            );
          })}
        </Row>
      )}

      <Row gap="var(--s4)" wrap style={{ fontSize: "var(--fs-sm)", color: "var(--fg-muted)" }}>
        <span>
          {formatCount(summary.inputTokens + summary.outputTokens)} tokens
          {calls > 0 && ` · ${formatCount(calls)} model ${calls === 1 ? "call" : "calls"}`}
        </span>
        <span>
          spend so far <Money usd={summary.costUsd} />
        </span>
        {summary.gateRounds > 1 && (
          <span style={{ color: "var(--warn)" }}>
            checks re-run {summary.gateRounds} times
            {summary.repairs > 0 && ` · ${summary.repairs} ${summary.repairs === 1 ? "repair" : "repairs"}`}
          </span>
        )}
      </Row>
    </Stack>
  );
}

/** A quiet breathing dot. Motion is the cheapest possible "this is not stuck". */
function Pulse(): ReactNode {
  return (
    <>
      <style>{`@keyframes signet-pulse{0%,100%{opacity:.35}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.signet-pulse{animation:none!important}}`}</style>
      <span
        aria-hidden="true"
        className="signet-pulse"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "var(--accent)",
          flex: "0 0 auto",
          animation: "signet-pulse 1.6s ease-in-out infinite",
        }}
      />
    </>
  );
}
