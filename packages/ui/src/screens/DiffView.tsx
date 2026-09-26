// What the agent actually changed, shown before signature 2.
//
// A merge button with nothing to review is a rubber stamp. The file summary comes
// first because it answers "did it touch what it said it would" in one glance,
// and the patch follows for the cases where that is not enough.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { Badge, Button, Card, Row, Stack } from "../ui/primitives.js";
import { ErrorNote } from "../ui/feedback.js";

export function DiffView({ incrementId }: { incrementId: string }) {
  const diff = useQuery({ queryKey: ["diff", incrementId], queryFn: () => api.diff(incrementId) });
  const [showPatch, setShowPatch] = useState(false);

  if (diff.isPending) return <span style={{ color: "var(--fg-muted)" }}>Reading the worktree…</span>;
  if (diff.error) return <ErrorNote error={diff.error} onRetry={() => void diff.refetch()} />;
  const d = diff.data;
  if (!d) return null;

  if (!d.available) {
    return <span style={{ color: "var(--fg-muted)" }}>{d.reason ?? "No diff available."}</span>;
  }
  if (d.files.length === 0) {
    return (
      <Card tone="warn" padding="var(--s3)">
        <span style={{ color: "var(--warn)" }}>
          The worktree has no changes against the base — nothing was written.
        </span>
      </Card>
    );
  }

  const added = d.files.reduce((s, f) => s + f.added, 0);
  const removed = d.files.reduce((s, f) => s + f.removed, 0);

  return (
    <Stack gap="var(--s2)">
      <Card padding="0">
        <Stack gap="0">
          {d.files.map((f, i) => (
            <Row
              key={f.path}
              justify="space-between"
              gap="var(--s3)"
              style={{ padding: "var(--s2) var(--s3)", borderTop: i === 0 ? "none" : "1px solid var(--line)" }}
            >
              <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-sm)", minWidth: 0, overflowWrap: "anywhere" }}>
                {f.path}
              </span>
              <Row gap="var(--s2)" style={{ flex: "0 0 auto", fontFamily: "var(--mono)", fontSize: "var(--fs-sm)" }}>
                <span style={{ color: "var(--ok)" }}>+{f.added}</span>
                <span style={{ color: "var(--err)" }}>−{f.removed}</span>
              </Row>
            </Row>
          ))}
        </Stack>
      </Card>

      <Row justify="space-between" wrap gap="var(--s2)">
        <Row gap="var(--s2)">
          <Badge>
            {d.files.length} file{d.files.length === 1 ? "" : "s"}
          </Badge>
          <Badge tone="ok">+{added}</Badge>
          <Badge tone="err">−{removed}</Badge>
        </Row>
        <Button size="sm" variant="quiet" onClick={() => setShowPatch(!showPatch)}>
          {showPatch ? "hide the patch" : "show the patch"}
        </Button>
      </Row>

      {showPatch && (
        <pre
          style={{
            margin: 0,
            maxHeight: 420,
            overflow: "auto",
            background: "var(--bg)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-sm)",
            padding: "var(--s3)",
            fontFamily: "var(--mono)",
            fontSize: "var(--fs-sm)",
            lineHeight: 1.55,
          }}
        >
          {d.patch.split("\n").map((line, i) => (
            <div key={i} style={{ color: lineColor(line), whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {line || " "}
            </div>
          ))}
        </pre>
      )}

      {d.truncated && (
        <span style={{ color: "var(--warn)", fontSize: "var(--fs-sm)" }}>
          The patch is truncated for display — a change this large is itself worth questioning.
        </span>
      )}
    </Stack>
  );
}

/** Diff colouring. File headers are dimmed so the actual changes stand out. */
function lineColor(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index "))
    return "var(--fg-subtle)";
  if (line.startsWith("@@")) return "var(--accent)";
  if (line.startsWith("+")) return "var(--ok)";
  if (line.startsWith("-")) return "var(--err)";
  return "var(--fg)";
}
