// Screen 1: the features board. Each card answers, in order:
// what is happening · does it need me · what do I do.

import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";

const STAGE_LABEL: Record<string, string> = {
  INTAKE: "In intake",
  DESIGN: "In design",
  DECOMPOSED: "Planned",
  IMPLEMENTING: "Implementing",
  DONE: "Done",
};

export function Board({ onOpen }: { onOpen: (id: string) => void }) {
  const features = useQuery({ queryKey: ["features"], queryFn: api.features, refetchInterval: 5000 });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 10000 });

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-8) var(--space-4)" }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <h1 style={{ fontSize: "var(--fs-xl)", margin: 0 }}>Signet</h1>
        <QuotaStrip health={health.data} />
      </header>

      <div style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-6)" }}>
        {features.data?.length === 0 && (
          <div style={{ color: "var(--text-dim)", padding: "var(--space-6)", textAlign: "center" }}>
            No features yet. Seed one through the API to begin.
          </div>
        )}
        {features.data?.map((f) => (
          <button
            key={f.id}
            onClick={() => onOpen(f.id)}
            style={{
              textAlign: "left",
              background: "var(--surface)",
              border: `1px solid ${f.needsHuman ? "var(--warn)" : "var(--border)"}`,
              borderRadius: "var(--radius)",
              padding: "var(--space-4)",
              display: "grid",
              gap: "var(--space-2)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)" }}>
              <strong style={{ fontSize: "var(--fs-lg)" }}>{f.title}</strong>
              {f.needsHuman && (
                <span style={{ color: "var(--warn)", fontWeight: 600, whiteSpace: "nowrap" }}>needs you</span>
              )}
            </div>
            <div style={{ color: "var(--text-dim)" }}>
              {STAGE_LABEL[f.stage] ?? f.stage} · {f.incrementsMerged}/{f.incrementsTotal} increments merged
            </div>
            {f.needsHumanWhy && <div style={{ color: "var(--warn)" }}>{f.needsHumanWhy}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

function QuotaStrip({
  health,
}: {
  health: { quota: { exhausted: boolean; resetsAt?: string | undefined } } | undefined;
}) {
  if (!health) return null;
  const q = health.quota;
  return (
    <span style={{ color: q.exhausted ? "var(--warn)" : "var(--text-dim)", fontSize: "var(--fs-sm)" }}>
      {q.exhausted
        ? `quota window exhausted${q.resetsAt ? ` · resumes ${new Date(q.resetsAt).toLocaleTimeString()}` : ""}`
        : "quota ok"}
    </span>
  );
}
