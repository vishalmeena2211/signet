// System: how this instance is actually wired, and whether each part works.
//
// This screen exists to settle arguments. "Which repo is it pointing at", "is it
// really using my Claude Code login", "is the base ref what I think it is" —
// every one of those was previously answered by reading a launch command. All of
// it is probed live on request, so a stale answer is impossible.

import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { Badge, Button, Card, Detail, Dot, Row, SectionTitle, Stack } from "../ui/primitives.js";
import { QueryState } from "../ui/feedback.js";
import { formatDuration, RelativeTime } from "../ui/format.js";

export function System() {
  const q = useQuery({ queryKey: ["system"], queryFn: api.system, refetchInterval: 15_000 });

  return (
    <QueryState isPending={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeletonRows={4}>
      {q.data && (
        <Stack gap="var(--s6)">
          <Stack gap="var(--s3)">
            <SectionTitle
              action={
                <Button size="sm" variant="quiet" onClick={() => void q.refetch()}>
                  re-run checks
                </Button>
              }
            >
              Health
            </SectionTitle>
            <Card padding="0">
              <Stack gap="0">
                {q.data.checks.map((c, i) => (
                  <Row
                    key={c.name}
                    justify="space-between"
                    gap="var(--s3)"
                    style={{ padding: "var(--s3)", borderTop: i === 0 ? "none" : "1px solid var(--line)" }}
                  >
                    <Row gap="var(--s2)">
                      <Dot tone={c.ok ? "ok" : "err"} />
                      <span style={{ fontWeight: 500 }}>{c.name}</span>
                    </Row>
                    <span
                      style={{
                        color: c.ok ? "var(--fg-muted)" : "var(--err)",
                        fontFamily: "var(--mono)",
                        fontSize: "var(--fs-sm)",
                        textAlign: "right",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {c.detail}
                    </span>
                  </Row>
                ))}
              </Stack>
            </Card>
            {q.data.checks.some((c) => !c.ok) && (
              <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
                A failing check is usually the whole diagnosis — the detail column is the error verbatim.
              </span>
            )}
          </Stack>

          <Stack gap="var(--s3)">
            <SectionTitle>Target</SectionTitle>
            <Card>
              <Stack gap="var(--s4)">
                <Row gap="var(--s6)" wrap>
                  <Detail label="Repository" mono>
                    {q.data.config.targetRepoPath}
                  </Detail>
                  <Detail label="Base ref" mono>
                    {q.data.config.baseRef}
                  </Detail>
                </Row>
                <Row gap="var(--s6)" wrap>
                  <Detail label="Worktrees" mono>
                    {q.data.config.workspacesRoot}
                  </Detail>
                  <Detail label="Context packs" mono>
                    {q.data.config.packsRoot}
                  </Detail>
                </Row>
              </Stack>
            </Card>
          </Stack>

          <Stack gap="var(--s3)">
            <SectionTitle>Agent</SectionTitle>
            <Card>
              <Row gap="var(--s6)" wrap>
                <Detail label="Claude Code" mono>
                  {q.data.config.claudeBinary}
                </Detail>
                <Detail label="Model">
                  {q.data.config.model === null ? (
                    <span title="No model is pinned, so a run uses whatever your Claude Code is configured to use.">
                      <Badge tone="idle">not pinned — your default</Badge>
                    </span>
                  ) : (
                    <Badge mono>{q.data.config.model}</Badge>
                  )}
                </Detail>
                <Detail label="Auth">
                  <span title="Signet drives the Claude Code CLI, which uses your own subscription login. No API key is ever read or stored.">
                    <Badge tone="ok">your subscription login</Badge>
                  </span>
                </Detail>
                <Detail label="Worker ceiling">
                  <span className="num">{q.data.config.maxConcurrentWorkers}</span>
                </Detail>
                <Detail label="Repair attempts">
                  <span className="num">{q.data.config.maxRepairIterations}</span>
                </Detail>
              </Row>
            </Card>
          </Stack>

          <Stack gap="var(--s3)">
            <SectionTitle>Instance</SectionTitle>
            <Card>
              <Row gap="var(--s6)" wrap>
                <Detail label="Listening on" mono>
                  {q.data.config.host}:{q.data.config.port}
                </Detail>
                <Detail label="Uptime">{formatDuration(q.data.uptimeSeconds * 1000)}</Detail>
                <Detail label="Started">
                  <RelativeTime iso={q.data.startedAt} />
                </Detail>
                <Detail label="Node" mono>
                  {q.data.nodeVersion}
                </Detail>
                <Detail label="Contracts" mono>
                  {q.data.contractsVersion}
                </Detail>
                <Detail label="Log level" mono>
                  {q.data.config.logLevel}
                </Detail>
              </Row>
            </Card>
            <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
              The console binds to loopback and enforces a host-header allowlist, so a browser tricked
              into resolving another name to 127.0.0.1 is rejected before any handler runs.
            </span>
          </Stack>
        </Stack>
      )}
    </QueryState>
  );
}
