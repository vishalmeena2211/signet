// Activity: watch the system work.
//
// Reconstructed from the journal rather than a live buffer, which means it
// survives a reload and shows what happened while nobody was looking — the two
// things an in-memory event log cannot do, and the two things you want most when
// you come back to a console after an hour away.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ActivityEvent } from "@signet/contracts";
import { api } from "../api.js";
import { navigate } from "../router.js";
import { Badge, Button, Card, Dot, Row, Segmented, Stack, type Tone } from "../ui/primitives.js";
import { EmptyState, QueryState } from "../ui/feedback.js";
import { RelativeTime } from "../ui/format.js";
import { useState } from "react";

const SEVERITY: Record<ActivityEvent["severity"], Tone> = {
  info: "idle",
  success: "ok",
  warn: "warn",
  error: "err",
};

const FILTERS = [
  { value: "all", label: "Everything" },
  { value: "problems", label: "Problems" },
  { value: "gates", label: "Checks" },
  { value: "runs", label: "Runs" },
] as const;

type Filter = (typeof FILTERS)[number]["value"];

export function Activity() {
  const [filter, setFilter] = useState<Filter>("all");
  const q = useQuery({
    queryKey: ["activity"],
    queryFn: () => api.activityFeed(200),
    refetchInterval: 4000,
  });

  const events = useMemo(() => {
    const all = q.data ?? [];
    switch (filter) {
      case "problems":
        return all.filter((e) => e.severity === "error" || e.severity === "warn");
      case "gates":
        return all.filter((e) => e.kind === "gate.verdict");
      case "runs":
        return all.filter((e) => e.kind.startsWith("run."));
      default:
        return all;
    }
  }, [q.data, filter]);

  const counts = useMemo(() => {
    const all = q.data ?? [];
    return {
      all: all.length,
      problems: all.filter((e) => e.severity === "error" || e.severity === "warn").length,
      gates: all.filter((e) => e.kind === "gate.verdict").length,
      runs: all.filter((e) => e.kind.startsWith("run.")).length,
    };
  }, [q.data]);

  // Day headers: a flat list of 200 timestamps is hard to place in time.
  const grouped = useMemo(() => {
    const out: { day: string; items: ActivityEvent[] }[] = [];
    for (const e of events) {
      const day = new Date(e.at).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(e);
      else out.push({ day, items: [e] });
    }
    return out;
  }, [events]);

  return (
    <Stack gap="var(--s4)">
      <Row justify="space-between" wrap gap="var(--s3)">
        <Segmented options={FILTERS.map((f) => ({ ...f, count: counts[f.value] }))} value={filter} onChange={setFilter} />
        <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
          rebuilt from the record, so it survives a restart
        </span>
      </Row>

      <QueryState isPending={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeletonRows={8}>
        {events.length === 0 ? (
          <EmptyState
            title={filter === "all" ? "Nothing has happened yet" : "Nothing matches this filter"}
            {...(filter === "all"
              ? { body: "Approve a step and you will see it work here, stage by stage." }
              : {})}
          />
        ) : (
          <Stack gap="var(--s4)">
            {grouped.map((g) => (
              <Stack key={g.day} gap="var(--s2)">
                <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  {g.day}
                </span>
                <Card padding="0">
                  <Stack gap="0">
                    {g.items.map((e, i) => (
                      <Row
                        key={`${e.at}-${e.kind}-${i}`}
                        gap="var(--s3)"
                        style={{
                          padding: "var(--s2) var(--s3)",
                          borderTop: i === 0 ? "none" : "1px solid var(--line)",
                        }}
                      >
                        <Dot tone={SEVERITY[e.severity]} />
                        <span
                          style={{
                            width: 120,
                            color: "var(--fg-subtle)",
                            fontFamily: "var(--mono)",
                            fontSize: "var(--fs-xs)",
                            flex: "0 0 auto",
                          }}
                        >
                          {e.kind}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>{e.summary}</span>
                        {e.featureId && (
                          <Button size="sm" variant="quiet" onClick={() => navigate({ view: "feature", id: e.featureId as string })}>
                            open
                          </Button>
                        )}
                        <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)", flex: "0 0 auto" }}>
                          <RelativeTime iso={e.at} />
                        </span>
                      </Row>
                    ))}
                  </Stack>
                </Card>
              </Stack>
            ))}
            {events.length >= 200 && (
              <Row justify="center">
                <Badge tone="idle">showing the most recent 200 events</Badge>
              </Row>
            )}
          </Stack>
        )}
      </QueryState>
    </Stack>
  );
}
