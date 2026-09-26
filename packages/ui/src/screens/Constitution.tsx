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
  Input,
  Row,
  SectionTitle,
  Segmented,
  Stack,
  TextArea,
  type Tone,
} from "../ui/primitives.js";
import { ConfirmButton, EmptyState, ErrorNote, QueryState, useToast } from "../ui/feedback.js";

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
  { value: "PROPOSED", label: "Proposed" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "DEMOTED", label: "Demoted" },
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
      <LearnPanel onLearned={invalidate} />

      <Stack gap="var(--s3)">
        <Row justify="space-between" wrap gap="var(--s3)">
          <Segmented
            options={STATUSES.map((s) => ({ ...s, count: byStatus[s.value].length }))}
            value={status}
            onChange={(v) => navigate({ view: "constitution", status: v })}
          />
          {status === "PROPOSED" && rules.length > 0 && (
            <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
              Nothing gates until you confirm it.
            </span>
          )}
          {status === "CONFIRMED" && rules.length > 0 && (
            <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
              These run as the rules gate, warning on added lines only.
            </span>
          )}
        </Row>

        <QueryState isPending={queue.isPending} error={queue.error} onRetry={() => void queue.refetch()} skeletonRows={4}>
          {rules.length === 0 ? (
            <EmptyState
              title={
                status === "PROPOSED"
                  ? "No proposals waiting"
                  : status === "CONFIRMED"
                    ? "No confirmed rules yet"
                    : "Nothing has been demoted"
              }
              body={
                status === "PROPOSED"
                  ? "Learn a repository above and Signet will propose the conventions it finds, with the evidence for each."
                  : status === "CONFIRMED"
                    ? "Confirm a proposal and it starts warning on new code that breaks it."
                    : "A confirmed rule is demoted automatically after three false positives, so one bad rule cannot erode trust in the rest."
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
  const learn = useMutation({
    mutationFn: () => api.learn(repoPath),
    onSuccess: (r) => {
      toast.push(`Learned ${r.label}: ${r.proposed} new proposals`, r.proposed > 0 ? "ok" : "neutral");
      onLearned();
    },
  });

  return (
    <Card>
      <Stack gap="var(--s3)">
        <SectionTitle>Learn a repository</SectionTitle>
        <p style={{ color: "var(--fg-muted)" }}>
          Signet reads the source and the git history, then proposes the conventions it can evidence —
          weighting the direction a convention is moving over how often it appears today.
        </p>
        <Row gap="var(--s2)" wrap align="flex-end">
          <div style={{ flex: "1 1 360px" }}>
            <Field label="Repository path" hint="An absolute path on this machine. Read-only — nothing is written.">
              <Input value={repoPath} onChange={setRepoPath} placeholder="/Users/you/code/your-frontend" mono />
            </Field>
          </div>
          <Button
            variant="primary"
            disabled={!repoPath.trim() || learn.isPending}
            onClick={() => learn.mutate()}
          >
            {learn.isPending ? "Reading…" : "Learn it"}
          </Button>
        </Row>
        {learn.data && (
          <span style={{ color: "var(--ok)" }}>
            {learn.data.label}: {learn.data.proposed} new proposal{learn.data.proposed === 1 ? "" : "s"} (
            {learn.data.skipped} already known).
          </span>
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
      toast.push("Confirmed — it will warn on new code that breaks it", "ok");
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
            Demoted automatically after {rule.fpCount} false positives. Re-confirm only if it is still
            right — a rule that cries wolf costs more than it catches.
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
                  {confirm.isPending ? "Confirming…" : rule.status === "DEMOTED" ? "Re-confirm" : "Confirm"}
                </Button>
                <Button disabled={busy} onClick={() => setEditing(true)}>
                  Edit wording
                </Button>
                <ConfirmButton
                  variant="danger"
                  question="It will not be proposed again."
                  confirmLabel="Reject it"
                  disabled={busy}
                  onConfirm={() => reject.mutate()}
                >
                  Reject
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
