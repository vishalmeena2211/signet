// The run pipeline, fetched and drawn.
//
// A thin wrapper so a screen can say "show me this step's pipeline" with an increment id
// and nothing else. It finds the newest run for the increment and draws it.
//
// Loaded on demand for the same reason the Automations screen is: this pulls React Flow,
// which is a fifth of the bundle, and a feature page opened to read a brief should not pay
// for a diagram nobody scrolled to.

import { lazy, Suspense, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GateVerdictView } from "@signet/contracts";
import { api } from "../api.js";

const RunCanvas = lazy(() => import("./run-canvas.js").then((m) => ({ default: m.RunCanvas })));

export interface RunPipelineProps {
  incrementId: string;
  incrementStatus: string;
  /** Verdicts already on the page, so the checks are drawn before the fetch lands. */
  verdicts: GateVerdictView[];
}

export function RunPipeline({ incrementId, incrementStatus, verdicts }: RunPipelineProps): ReactNode {
  // Newest run only. A retried increment has several, and the pipeline of the one that
  // is current is what somebody looking at this page is asking about.
  const runs = useQuery({
    queryKey: ["runs", { incrementId, limit: 1 }],
    queryFn: () => api.runs({ incrementId, limit: 1 }),
  });
  const runId = runs.data?.[0]?.id;

  const detail = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId as string),
    enabled: Boolean(runId),
    // While anything is in flight the phases change; once terminal they never will again.
    refetchInterval: incrementStatus === "RUNNING" || incrementStatus === "VERIFYING" ? 4000 : false,
  });

  if (runs.isPending) return <span style={{ color: "var(--fg-muted)" }}>Loading…</span>;
  if (!runId) {
    // Not an error: a step that has never been approved has no pipeline to draw, and
    // saying so plainly beats an empty canvas that looks broken.
    return (
      <span style={{ color: "var(--fg-muted)" }}>
        Nothing has run yet, so there is no pipeline to show. Approve the step to start one.
      </span>
    );
  }
  if (!detail.data) return <span style={{ color: "var(--fg-muted)" }}>Loading…</span>;

  return (
    <Suspense fallback={<span style={{ color: "var(--fg-muted)" }}>Loading…</span>}>
      <RunCanvas
        phases={detail.data.phases}
        verdicts={verdicts}
        gateRounds={detail.data.summary.gateRounds}
        incrementStatus={incrementStatus}
      />
    </Suspense>
  );
}
