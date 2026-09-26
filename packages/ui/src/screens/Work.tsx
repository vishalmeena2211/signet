// Work: every feature, one row each.
//
// This was a list of cards, which is the wrong shape as soon as there are more
// than about six: an operator comparing twenty features wants to sort by what
// needs attention and scan down a column, not scroll past twenty boxes. Filter
// and search state live in the URL so a filtered view can be shared.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FeatureSummary } from "@signet/contracts";
import { api } from "../api.js";
import { navigate, type Route } from "../router.js";
import { Badge, Button, Input, Meter, Row, Segmented, Stack } from "../ui/primitives.js";
import { EmptyState, QueryState } from "../ui/feedback.js";
import { DataTable, type Column } from "../ui/table.js";
import { Id } from "../ui/format.js";

const STAGE: Record<string, { label: string; tone: "idle" | "accent" | "run" | "ok" }> = {
  INTAKE: { label: "Intake", tone: "idle" },
  DESIGN: { label: "Design", tone: "idle" },
  DECOMPOSED: { label: "Planned", tone: "accent" },
  IMPLEMENTING: { label: "Implementing", tone: "run" },
  DONE: { label: "Done", tone: "ok" },
};

const FILTERS = [
  { value: "all", label: "All" },
  { value: "needs-you", label: "Needs you" },
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
] as const;

export function Work({ route }: { route: Extract<Route, { view: "work" }> }) {
  const q = useQuery({ queryKey: ["features"], queryFn: api.features, refetchInterval: 5000 });
  const status = route.status ?? "all";
  const search = route.q ?? "";

  const rows = useMemo(() => {
    let list = q.data ?? [];
    if (status === "needs-you") list = list.filter((f) => f.needsHuman);
    else if (status === "active") list = list.filter((f) => f.stage !== "DONE");
    else if (status === "done") list = list.filter((f) => f.stage === "DONE");
    const needle = search.trim().toLowerCase();
    if (needle) list = list.filter((f) => f.title.toLowerCase().includes(needle));
    return list;
  }, [q.data, status, search]);

  const counts = useMemo(() => {
    const all = q.data ?? [];
    return {
      all: all.length,
      "needs-you": all.filter((f) => f.needsHuman).length,
      active: all.filter((f) => f.stage !== "DONE").length,
      done: all.filter((f) => f.stage === "DONE").length,
    };
  }, [q.data]);

  const columns: Column<FeatureSummary>[] = [
    {
      key: "title",
      header: "Feature",
      sort: (a, b) => a.title.localeCompare(b.title),
      render: (f) => (
        <Stack gap="1px" style={{ minWidth: 0 }}>
          <Row gap="var(--s2)">
            <span style={{ fontWeight: 500 }}>{f.title}</span>
            {f.needsHuman && <Badge tone="warn">needs you</Badge>}
          </Row>
          {f.needsHumanWhy && (
            <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>{f.needsHumanWhy}</span>
          )}
        </Stack>
      ),
    },
    {
      key: "stage",
      header: "Stage",
      width: "130px",
      sort: (a, b) => a.stage.localeCompare(b.stage),
      render: (f) => {
        const s = STAGE[f.stage] ?? { label: f.stage, tone: "idle" as const };
        return <Badge tone={s.tone}>{s.label}</Badge>;
      },
    },
    {
      key: "progress",
      header: "Steps",
      width: "150px",
      sort: (a, b) =>
        a.incrementsMerged / Math.max(a.incrementsTotal, 1) - b.incrementsMerged / Math.max(b.incrementsTotal, 1),
      render: (f) => (
        <Stack gap="var(--s1)">
          <span className="num" style={{ fontSize: "var(--fs-sm)" }}>
            {f.incrementsMerged}/{f.incrementsTotal} done
          </span>
          <Meter
            value={f.incrementsMerged}
            max={f.incrementsTotal}
            tone={f.incrementsMerged === f.incrementsTotal ? "ok" : "accent"}
          />
        </Stack>
      ),
    },
    {
      key: "id",
      header: "Id",
      width: "70px",
      render: (f) => <Id value={f.id} label="feature" />,
    },
  ];

  return (
    <Stack gap="var(--s4)">
      <Row justify="space-between" wrap gap="var(--s3)">
        <Segmented
          options={FILTERS.map((f) => ({ ...f, count: counts[f.value] }))}
          value={status}
          onChange={(v) => navigate({ view: "work", status: v, ...(search ? { q: search } : {}) })}
        />
        <Row gap="var(--s2)">
          <div style={{ width: 240 }}>
            <Input
              value={search}
              placeholder="Filter by title…"
              onChange={(v) => navigate({ view: "work", status, ...(v ? { q: v } : {}) })}
            />
          </div>
          <Button variant="primary" onClick={() => navigate({ view: "new" })}>
            New feature
          </Button>
        </Row>
      </Row>

      <QueryState isPending={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeletonRows={5}>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(f) => f.id}
          onOpen={(f) => navigate({ view: "feature", id: f.id })}
          initialSort={{ key: "title", dir: "asc" }}
          empty={
            (q.data ?? []).length === 0 ? (
              <EmptyState
                title="No features yet"
                body="Describe what you want built and break it into steps. Signet takes it from there."
                action={
                  <Button variant="primary" onClick={() => navigate({ view: "new" })}>
                    New feature
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="Nothing matches this filter"
                body="Try a different status, or clear the search."
                action={<Button onClick={() => navigate({ view: "work" })}>Clear filters</Button>}
              />
            )
          }
        />
      </QueryState>
    </Stack>
  );
}
