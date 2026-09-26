// The constitution: rules mined from a repository, awaiting human judgement.
//
// The research behind this product is explicit that rules die above roughly a
// 10% false-positive rate, while suggestions survive at about 50% acceptance. So
// nothing here gates until a person confirms it, the evidence is always one click
// away, and a rule that produces false positives is demoted automatically rather
// than quietly eroding trust in every other rule.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RuleCard } from "@signet/contracts";
import { api } from "../api.js";
import { type Route, navigate } from "../router.js";
import {
  Badge,
  Button,
  Card,
  Divider,
  Field,
  Row,
  Segmented,
  Stack,
  TextArea,
  type Tone,
} from "../ui/primitives.js";
import { ConfirmButton, EmptyState, ErrorNote, QueryState, useToast } from "../ui/feedback.js";
import { Combobox } from "../ui/combobox.js";
import { Forensics } from "../ui/tiers.js";
import { RelativeTime } from "../ui/format.js";

/**
 * Trend is the novel part of the mining: a convention's direction matters more
 * than its count, because a token being adopted looks identical to a literal
 * being abandoned if you only count occurrences at HEAD.
 */
const TREND: Record<string, { tone: Tone; help: string }> = {
  new: { tone: "accent", help: "Appeared recently — a convention being established." },
  growing: { tone: "ok", help: "Used more over time — the direction the codebase is moving." },
  stable: { tone: "idle", help: "Steady usage across the sampled history." },
  dying: { tone: "warn", help: "Used less over time — probably being migrated away from." },
  gone: { tone: "err", help: "No longer present at HEAD." },
  unknown: { tone: "idle", help: "Not enough history to judge a direction." },
};

const KIND: Record<string, string> = {
  color: "colour",
  asset: "asset",
  token: "token",
  spacing: "spacing",
  typography: "type",
};

const STATUSES = [
  { value: "PROPOSED", label: "Suggested" },
  { value: "CONFIRMED", label: "Accepted" },
  { value: "DEMOTED", label: "Set aside" },
] as const;

export function Constitution({ route }: { route: Extract<Route, { view: "constitution" }> }) {
  const qc = useQueryClient();
  const status = route.status ?? "PROPOSED";
  const queue = useQuery({ queryKey: ["rules"], queryFn: () => api.ruleQueue(), refetchInterval: 8000 });

  const byStatus = useMemo(() => {
    const all = queue.data ?? [];
    return {
      PROPOSED: all.filter((r) => r.status === "PROPOSED"),
      CONFIRMED: all.filter((r) => r.status === "CONFIRMED"),
      DEMOTED: all.filter((r) => r.status === "DEMOTED"),
    };
  }, [queue.data]);

  const rules = byStatus[status as keyof typeof byStatus] ?? [];
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["rules"] });

  return (
    <Stack gap="var(--s5)">
      {/* Learning a repository is occasional; reviewing the queue is why you are
          here. So the panel folds away unless the queue is empty, in which case
          it IS the next step. */}
      <Forensics
        id="constitution.learn"
        label="Learn a repository"
        defaultOpen={(queue.data ?? []).length === 0}
      >
        <LearnPanel onLearned={invalidate} />
      </Forensics>

      <Stack gap="var(--s3)">
        <Row justify="space-between" wrap gap="var(--s3)">
          <Segmented
            options={STATUSES.map((s) => ({ ...s, count: byStatus[s.value].length }))}
            value={status}
            onChange={(v) => navigate({ view: "constitution", status: v })}
          />
          {status === "PROPOSED" && rules.length > 0 && (
            <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
              Nothing is enforced until you accept it.
            </span>
          )}
          {status === "CONFIRMED" && rules.length > 0 && (
            <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
              These warn you when new code breaks them.
            </span>
          )}
        </Row>

        <QueryState isPending={queue.isPending} error={queue.error} onRetry={() => void queue.refetch()} skeletonRows={4}>
          {rules.length === 0 ? (
            <EmptyState
              title={
                status === "PROPOSED"
                  ? "Nothing to review"
                  : status === "CONFIRMED"
                    ? "No rules accepted yet"
                    : "Nothing has been set aside"
              }
              body={
                status === "PROPOSED"
                  ? "Point Signet at a repository above and it will suggest the conventions it finds, with the evidence for each."
                  : status === "CONFIRMED"
                    ? "Accept a suggestion and it starts warning you when new code breaks it."
                    : "A rule turns itself off after three false alarms, so one bad rule cannot spoil the rest."
              }
            />
          ) : (
            <Stack gap="var(--s2)">
              {rules.map((r) => (
                <RuleRow key={r.id} rule={r} onDone={invalidate} />
              ))}
            </Stack>
          )}
        </QueryState>
      </Stack>
    </Stack>
  );
}

function LearnPanel({ onLearned }: { onLearned: () => void }) {
  const [repoPath, setRepoPath] = useState("");
  const toast = useToast();

  // Only fetched when the panel is open, so the queue does not cost a GitHub
  // request on every visit.
  const repos = useQuery({
    queryKey: ["github", "repos"],
    queryFn: api.githubRepos,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const learn = useMutation({
    mutationFn: () => api.learn(repoPath),
    onSuccess: (r) => {
      toast.push(`Learned ${r.label}: ${r.proposed} new proposals`, r.proposed > 0 ? "ok" : "neutral");
      onLearned();
    },
  });

  const options = (repos.data?.repos ?? []).map((r) => ({
    value: r.fullName,
    label: r.fullName,
    ...(r.description ? { hint: r.description } : {}),
    meta: (
      <Row gap="var(--s2)" style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)" }}>
        {r.private && <Badge tone="idle">private</Badge>}
        {r.language && <span>{r.language}</span>}
        <RelativeTime iso={r.updatedAt} />
      </Row>
    ),
  }));

  const isGithub = repoPath.includes("github.com") || (repoPath.includes("/") && !repoPath.startsWith("/"));

  return (
    <Card>
      <Stack gap="var(--s3)">
        <p style={{ color: "var(--fg-muted)" }}>
          Signet reads the source and the git history, then proposes the conventions it can evidence —
          weighting the direction a convention is moving over how often it appears today.
        </p>
        <Row gap="var(--s2)" wrap align="flex-end">
          <div style={{ flex: "1 1 380px", minWidth: 0 }}>
            <Field
              label="Repository"
              hint={
                repos.data?.authenticated
                  ? `Search your GitHub repositories${repos.data.login ? ` as ${repos.data.login}` : ""}, paste any URL, or give a local absolute path. Read-only either way.`
                  : "A local absolute path, or a GitHub repository — a URL, or owner/repo. Read-only either way."
              }
            >
              <Combobox
                value={repoPath}
                onChange={setRepoPath}
                options={options}
                loading={repos.isPending}
                mono
                placeholder="Search your repositories, or paste a path or URL"
                {...(repos.data?.reason ? { emptyNote: repos.data.reason } : {})}
                onSubmit={() => {
                  if (repoPath.trim() && !learn.isPending) learn.mutate();
                }}
              />
            </Field>
          </div>
          <Button variant="primary" disabled={!repoPath.trim() || learn.isPending} onClick={() => learn.mutate()}>
            {learn.isPending ? (isGithub ? "Cloning & reading…" : "Reading…") : "Learn it"}
          </Button>
        </Row>

        {repos.data?.truncated && (
          <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
            Showing your 100 most recently pushed repositories. Paste a URL for anything older.
          </span>
        )}

        {learn.data && (
          <Stack gap="var(--s1)">
            <span style={{ color: "var(--ok)" }}>
              {learn.data.label}: {learn.data.proposed} new proposal{learn.data.proposed === 1 ? "" : "s"} (
              {learn.data.skipped} already known).
            </span>
            {learn.data.source?.kind === "github" && (
              <Row gap="var(--s2)" wrap style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
                <Badge mono>{learn.data.source.repo}</Badge>
                <span>
                  {learn.data.source.branch} at {learn.data.source.headSha}
                </span>
                <span>
                  {learn.data.source.commits} commits, history from{" "}
                  {new Date(learn.data.source.historyFrom).toLocaleDateString()}
                </span>
                {learn.data.source.fromCache && <Badge tone="idle">from cache</Badge>}
              </Row>
            )}
          </Stack>
        )}
        <ErrorNote error={learn.error} onDismiss={() => learn.reset()} />
      </Stack>
    </Card>
  );
}

function RuleRow({ rule, onDone }: { rule: RuleCard; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.statement);
  const [showEvidence, setShowEvidence] = useState(false);
  const toast = useToast();

  const confirm = useMutation({
    mutationFn: () => api.confirmRule(rule.id),
    onSuccess: () => {
      toast.push("Accepted — it will warn you when new code breaks it", "ok");
      onDone();
    },
  });
  const reject = useMutation({ mutationFn: () => api.rejectRule(rule.id), onSuccess: onDone });
  const save = useMutation({
    mutationFn: () => api.editRule(rule.id, text),
    onSuccess: () => {
      setEditing(false);
      toast.push("Rule updated", "ok");
      onDone();
    },
  });
  const acts = [confirm, reject, save];
  const busy = acts.some((a) => a.isPending);
  const failure = acts.find((a) => a.error)?.error;
  const trend = TREND[rule.trend] ?? TREND.unknown;

  return (
    <Card tone={rule.status === "DEMOTED" ? "warn" : "neutral"} padding="var(--s3)">
      <Stack gap="var(--s3)">
        <Row justify="space-between" wrap gap="var(--s3)" align="flex-start">
          {editing ? (
            <div style={{ flex: "1 1 320px" }}>
              <TextArea value={text} onChange={setText} rows={2} />
            </div>
          ) : (
            <span style={{ fontSize: "var(--fs-md)", minWidth: 0 }}>{rule.statement}</span>
          )}
          <Row gap="var(--s2)" style={{ flex: "0 0 auto" }}>
            <Badge mono>{KIND[rule.kind] ?? rule.kind}</Badge>
            <span title={trend?.help}>
              <Badge tone={trend?.tone ?? "idle"}>{rule.trend}</Badge>
            </span>
            <span title="How strongly the evidence supports this rule">
              <Badge tone={rule.confidence >= 0.8 ? "ok" : rule.confidence >= 0.5 ? "warn" : "idle"}>
                {Math.round(rule.confidence * 100)}%
              </Badge>
            </span>
          </Row>
        </Row>

        {rule.status === "DEMOTED" && (
          <span style={{ color: "var(--warn)", fontSize: "var(--fs-sm)" }}>
            Set aside after {rule.fpCount} false alarms. Accept it again only if it is still right — a
            rule that cries wolf costs more than it catches.
          </span>
        )}

        {showEvidence && (
          <Card padding="var(--s2)" style={{ background: "var(--bg)" }}>
            <Stack gap="var(--s1)">
              {rule.evidence.map((e, i) => (
                <Row key={i} gap="var(--s2)" align="baseline">
                  <Badge mono>{e.kind}</Badge>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-sm)", minWidth: 0 }}>
                    {e.ref}
                    {e.detail && <span style={{ color: "var(--fg-subtle)" }}> — {e.detail}</span>}
                  </span>
                </Row>
              ))}
            </Stack>
          </Card>
        )}

        <ErrorNote error={failure} onDismiss={() => acts.forEach((a) => a.reset())} />

        <Divider />

        <Row justify="space-between" wrap gap="var(--s2)">
          <Row gap="var(--s2)" wrap>
            {editing ? (
              <>
                <Button variant="primary" disabled={busy || !text.trim()} onClick={() => save.mutate()}>
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => {
                    setText(rule.statement);
                    setEditing(false);
                  }}
                >
                  cancel
                </Button>
              </>
            ) : (
              <>
                <Button variant="primary" disabled={busy} onClick={() => confirm.mutate()}>
                  {confirm.isPending ? "Accepting…" : rule.status === "DEMOTED" ? "Accept again" : "Accept"}
                </Button>
                <Button disabled={busy} onClick={() => setEditing(true)}>
                  Edit wording
                </Button>
                <ConfirmButton
                  variant="danger"
                  question="Signet will not suggest it again."
                  confirmLabel="Discard it"
                  disabled={busy}
                  onConfirm={() => reject.mutate()}
                >
                  Discard
                </ConfirmButton>
              </>
            )}
          </Row>
          <Button size="sm" variant="quiet" onClick={() => setShowEvidence(!showEvidence)}>
            {showEvidence ? "hide" : "show"} {rule.evidence.length} evidence item
            {rule.evidence.length === 1 ? "" : "s"}
          </Button>
        </Row>
      </Stack>
    </Card>
  );
}
