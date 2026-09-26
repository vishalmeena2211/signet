// What the agent actually changed. Shown before signature 2, because a merge
// button with nothing to review is a rubber stamp.

import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { ErrorNote } from "../components.js";

export function DiffView({ incrementId }: { incrementId: string }) {
  const diff = useQuery({ queryKey: ["diff", incrementId], queryFn: () => api.diff(incrementId) });

  if (diff.isPending) return <div style={{ color: "var(--text-dim)" }}>Reading the worktree…</div>;
  if (diff.error) return <ErrorNote error={diff.error} />;
  const d = diff.data;
  if (!d) return null;
  if (!d.available) {
    return <div style={{ color: "var(--text-dim)" }}>{d.reason ?? "No diff available."}</div>;
  }
  if (d.files.length === 0) {
    return (
      <div style={{ color: "var(--warn)" }}>
        The worktree has no changes against the base — nothing was written.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      <div style={{ display: "grid", gap: "var(--space-1)" }}>
        {d.files.map((f) => (
          <div key={f.path} style={{ display: "flex", gap: "var(--space-3)", fontFamily: "var(--mono)", fontSize: "var(--fs-sm)" }}>
            <span style={{ color: "var(--ok)" }}>+{f.added}</span>
            <span style={{ color: "var(--fail)" }}>−{f.removed}</span>
            <span>{f.path}</span>
          </div>
        ))}
      </div>
      <pre
        style={{
          margin: 0,
          maxHeight: 360,
          overflow: "auto",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          padding: "var(--space-3)",
          fontFamily: "var(--mono)",
          fontSize: "var(--fs-sm)",
          lineHeight: 1.5,
        }}
      >
        {d.patch.split("\n").map((line, i) => (
          <div
            key={i}
            style={{
              color: line.startsWith("+++") || line.startsWith("---")
                ? "var(--text-dim)"
                : line.startsWith("+")
                  ? "var(--ok)"
                  : line.startsWith("-")
                    ? "var(--fail)"
                    : line.startsWith("@@")
                      ? "var(--accent)"
                      : "var(--text)",
              whiteSpace: "pre-wrap",
            }}
          >
            {line || " "}
          </div>
        ))}
      </pre>
      {d.truncated && (
        <div style={{ color: "var(--warn)", fontSize: "var(--fs-sm)" }}>
          Diff truncated for display — a change this large is itself worth questioning.
        </div>
      )}
    </div>
  );
}
