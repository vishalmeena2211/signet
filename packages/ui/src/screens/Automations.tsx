// Automations: saved requests, and what runs them.
//
// Three things on one screen, because they are one idea seen from three angles:
//
//   · RECIPES — a saved request. Leave {{blanks}} in it and it is a template you fill
//     in; leave none and it is a one-click action.
//   · WORKFLOWS — an ordered list of recipes plus a trigger.
//   · HISTORY — what actually fired, and what it produced.
//
// The boundary that gets stated out loud, twice: automation never merges. It can
// propose, plan, write and check; the merge always waits for you. That is not a
// limitation to apologise for — it is the reason this is safe to switch on.
//
// The kill switch sits at the top rather than in a settings page. The moment you want
// it is the moment you do not want to go looking for it.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Recipe, Workflow, WorkflowTrigger } from "@signet/contracts";
import { api } from "../api.js";
import { navigate } from "../router.js";
import { Badge, Button, Card, Dot, Field, Input, Row, Stack, TextArea } from "../ui/primitives.js";
import { ConfirmButton, EmptyState, ErrorNote, QueryState, useToast } from "../ui/feedback.js";
import { Decide, Forensics, RowDivider, Understand } from "../ui/tiers.js";
import { RelativeTime } from "../ui/format.js";
import { Combobox } from "../ui/combobox.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A trigger in the words the screen uses, rather than its shape. */
function describeTrigger(t: WorkflowTrigger): string {
  if (t.kind === "manual") return "Only when you press run";
  if (t.kind === "event") {
    return {
      step_merged: "After any step is merged",
      run_failed: "After a run fails",
      rules_proposed: "After new rules are proposed",
      quota_reset: "When your Claude quota resets",
    }[t.event];
  }
  const at = `${String(t.atHour).padStart(2, "0")}:${String(t.atMinute).padStart(2, "0")}`;
  if (t.every === "hour") return `Every hour at ${String(t.atMinute).padStart(2, "0")} past`;
  if (t.every === "day") return `Every day at ${at}`;
  return `Every ${WEEKDAYS[t.onWeekday]} at ${at}`;
}

export function Automations() {
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["recipes"] });
    void qc.invalidateQueries({ queryKey: ["workflows"] });
    void qc.invalidateQueries({ queryKey: ["workflow-runs"] });
    void qc.invalidateQueries({ queryKey: ["automation"] });
  };

  const state = useQuery({ queryKey: ["automation"], queryFn: api.automationState, refetchInterval: 10_000 });
  const recipes = useQuery({ queryKey: ["recipes"], queryFn: api.recipes });
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: api.workflows });
  const runs = useQuery({ queryKey: ["workflow-runs"], queryFn: api.workflowRuns, refetchInterval: 10_000 });

  const pause = useMutation({
    mutationFn: (paused: boolean) => api.setAutomationPaused(paused),
    onSuccess: (s) => {
      toast.push(s.paused ? "Automation paused" : "Automation resumed", s.paused ? "warn" : "ok");
      invalidate();
    },
  });

  return (
    <Stack gap="var(--s8)">
      <Row justify="space-between" wrap gap="var(--s3)">
        <Stack gap="var(--s1)">
          <h1 style={{ fontSize: "var(--fs-xl)" }}>Automations</h1>
          {/* Said here and again beside the run button. The whole reason this is safe to
              switch on is that it cannot land code. */}
          <span style={{ color: "var(--fg-muted)" }}>
            Automation prepares work and starts it. It never merges — that signature is always yours.
          </span>
        </Stack>
        {state.data && (
          <Button
            variant={state.data.paused ? "primary" : "quiet"}
            disabled={pause.isPending}
            onClick={() => pause.mutate(!state.data.paused)}
          >
            {state.data.paused ? "Resume automation" : "Pause all automation"}
          </Button>
        )}
      </Row>

      {state.data?.paused && (
        <Card tone="warn">
          <Row gap="var(--s2)" wrap>
            <Badge tone="warn">paused</Badge>
            <span>
              Nothing will fire on a schedule or an event. You can still run a workflow by hand — the switch is
              for things happening while you are not watching.
            </span>
          </Row>
        </Card>
      )}

      <ErrorNote error={pause.error} onDismiss={() => pause.reset()} />

      <QueryState isPending={recipes.isPending} error={recipes.error} onRetry={() => void recipes.refetch()}>
        <Recipes recipes={recipes.data ?? []} onChanged={invalidate} />
      </QueryState>

      <QueryState isPending={workflows.isPending} error={workflows.error} onRetry={() => void workflows.refetch()}>
        <Workflows workflows={workflows.data ?? []} recipes={recipes.data ?? []} onChanged={invalidate} />
      </QueryState>

      <Understand title="What has fired">
        {(runs.data ?? []).length === 0 ? (
          <EmptyState title="Nothing has run yet" body="Workflow runs appear here with what they produced." />
        ) : (
          <Card padding="0">
            {(runs.data ?? []).map((r, i) => (
              <div key={r.id}>
                {i > 0 && <RowDivider />}
                <Row justify="space-between" wrap gap="var(--s3)" style={{ padding: "var(--s3)" }}>
                  <Row gap="var(--s3)" style={{ minWidth: 0 }}>
                    <Dot
                      tone={
                        r.status === "succeeded"
                          ? "ok"
                          : r.status === "failed"
                            ? "err"
                            : r.status === "running"
                              ? "run"
                              : "idle"
                      }
                    />
                    <Stack gap="2px" style={{ minWidth: 0 }}>
                      <Row gap="var(--s2)" wrap>
                        <span>{r.workflowName}</span>
                        <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
                          {r.triggeredBy}
                          {r.depth > 0 ? ` · ${r.depth} deep` : ""}
                        </span>
                      </Row>
                      {/* A skip with no reason is indistinguishable from never firing,
                          which is the worst state for unattended work. */}
                      {r.skipReason && (
                        <span style={{ color: "var(--warn)", fontSize: "var(--fs-sm)" }}>{r.skipReason}</span>
                      )}
                      {r.outcomes.map((o, j) => (
                        <span key={j} style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
                          {o.error ? (
                            <span style={{ color: "var(--err)" }}>
                              {o.recipeName}: {o.error}
                            </span>
                          ) : (
                            <>
                              {o.recipeName}: queued {o.stepsQueued} step{o.stepsQueued === 1 ? "" : "s"}
                              {o.featureId && (
                                <>
                                  {" · "}
                                  <a href={`#/work/${o.featureId}`}>open</a>
                                </>
                              )}
                            </>
                          )}
                        </span>
                      ))}
                    </Stack>
                  </Row>
                  <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
                    <RelativeTime iso={r.startedAt} />
                  </span>
                </Row>
              </div>
            ))}
          </Card>
        )}
      </Understand>
    </Stack>
  );
}

function Recipes({ recipes, onChanged }: { recipes: Recipe[]; onChanged: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [repoId, setRepoId] = useState("");

  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repoOptions, staleTime: 60_000 });

  const create = useMutation({
    mutationFn: () =>
      api.createRecipe({ name: name.trim(), goalMd: goal.trim(), ...(repoId ? { repoId } : {}) }),
    onSuccess: () => {
      toast.push("Recipe saved", "ok");
      setOpen(false);
      setName("");
      setGoal("");
      onChanged();
    },
  });

  const remove = useMutation({
    mutationFn: api.deleteRecipe,
    onSuccess: () => {
      toast.push("Recipe deleted", "ok");
      onChanged();
    },
  });

  const problem =
    name.trim().length === 0
      ? "Give it a name."
      : goal.trim().length < 20
        ? "Describe what it should build, the same way you would when creating a feature."
        : null;

  return (
    <Decide
      title="Recipes"
      meta={
        <Button size="sm" variant={open ? "quiet" : "primary"} onClick={() => setOpen(!open)}>
          {open ? "Cancel" : "New recipe"}
        </Button>
      }
    >
      <p style={{ color: "var(--fg-muted)" }}>
        A saved request. Leave <code>{"{{blanks}}"}</code> in the description and it becomes a template you fill
        in each time; leave none and it can be run with one click, or put into a workflow.
      </p>

      {open && (
        <Card>
          <Stack gap="var(--s4)">
            <Field label="Name" hint="How it appears in a workflow.">
              <Input value={name} onChange={setName} placeholder="Tidy up tests" />
            </Field>
            <Field label="Which repo">
              <Combobox
                value={repoId}
                onChange={setRepoId}
                mono
                loading={repos.isPending}
                placeholder="~/code/my-project"
                options={(repos.data?.repos ?? []).map((r) => ({
                  value: r.id,
                  label: r.label,
                  ...(r.isConfigured ? { hint: "this instance's default" } : {}),
                  meta: r.canMerge ? undefined : "plan only",
                }))}
              />
            </Field>
            <Field
              label="What it should build"
              hint="Signet proposes the step breakdown when it runs, the same as creating a feature by hand."
            >
              <TextArea
                value={goal}
                onChange={setGoal}
                rows={5}
                mono
                placeholder="Find any module in the cart area with no test file and add one covering its main path."
              />
            </Field>
            <Row gap="var(--s3)" wrap>
              <Button variant="primary" disabled={problem !== null || create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? "Saving…" : "Save recipe"}
              </Button>
              {problem && <span style={{ color: "var(--fg-muted)" }}>{problem}</span>}
            </Row>
            <ErrorNote error={create.error} onDismiss={() => create.reset()} />
          </Stack>
        </Card>
      )}

      <ErrorNote error={remove.error} onDismiss={() => remove.reset()} />

      {recipes.length === 0 ? (
        <EmptyState
          title="No recipes yet"
          body="A recipe is a request you expect to make more than once."
          action={
            <Button variant="primary" onClick={() => setOpen(true)}>
              Create one
            </Button>
          }
        />
      ) : (
        <Card padding="0">
          {recipes.map((r, i) => (
            <div key={r.id}>
              {i > 0 && <RowDivider />}
              <Row justify="space-between" wrap gap="var(--s3)" style={{ padding: "var(--s3)" }}>
                <Stack gap="2px" style={{ minWidth: 0 }}>
                  <Row gap="var(--s2)" wrap>
                    <strong>{r.name}</strong>
                    {r.placeholders.length > 0 ? (
                      <Badge tone="idle">template · {r.placeholders.join(", ")}</Badge>
                    ) : (
                      <Badge tone="ok">ready to run</Badge>
                    )}
                    {r.repoLabel && (
                      <span style={{ color: "var(--fg-subtle)", fontFamily: "var(--mono)", fontSize: "var(--fs-sm)" }}>
                        {r.repoLabel}
                      </span>
                    )}
                  </Row>
                  <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
                    {r.goalMd.length > 140 ? `${r.goalMd.slice(0, 140)}…` : r.goalMd}
                  </span>
                  {/* A template cannot run unattended, and saying so here stops somebody
                      building a workflow around one and wondering why it always skips. */}
                  {r.placeholders.length > 0 && (
                    <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
                      Has blanks, so it cannot run on a schedule — there would be nobody to fill them in.
                    </span>
                  )}
                </Stack>
                <ConfirmButton
                  question="Delete this recipe?"
                  confirmLabel="Delete"
                  disabled={remove.isPending}
                  onConfirm={() => remove.mutate(r.id)}
                >
                  Delete
                </ConfirmButton>
              </Row>
            </div>
          ))}
        </Card>
      )}
    </Decide>
  );
}

function Workflows({
  workflows,
  recipes,
  onChanged,
}: {
  workflows: Workflow[];
  recipes: Recipe[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [kind, setKind] = useState<"manual" | "schedule" | "event">("schedule");
  const [every, setEvery] = useState<"hour" | "day" | "week">("day");
  const [atHour, setAtHour] = useState("9");
  const [event, setEvent] = useState<"step_merged" | "run_failed" | "rules_proposed" | "quota_reset">("step_merged");

  const trigger = (): WorkflowTrigger =>
    kind === "manual"
      ? { kind: "manual" }
      : kind === "event"
        ? { kind: "event", event }
        : { kind: "schedule", every, atHour: Number(atHour) || 9, atMinute: 0, onWeekday: 1 };

  const save = useMutation({
    mutationFn: () =>
      api.saveWorkflow({
        name: name.trim(),
        trigger: trigger(),
        recipeIds: picked,
        maxDepth: 1,
        // Off by default. An automation nobody armed should never have fired.
        enabled: false,
      }),
    onSuccess: () => {
      toast.push("Workflow saved — switch it on when you are ready", "ok");
      setOpen(false);
      setName("");
      setPicked([]);
      onChanged();
    },
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setWorkflowEnabled(id, enabled),
    onSuccess: () => onChanged(),
  });

  const runNow = useMutation({
    mutationFn: api.runWorkflow,
    onSuccess: (res) => {
      // A refusal is reported, never swallowed into a success toast.
      toast.push(res.started ? "Workflow started" : (res.reason ?? "Nothing ran"), res.started ? "ok" : "warn");
      onChanged();
    },
  });

  const remove = useMutation({ mutationFn: api.deleteWorkflow, onSuccess: () => onChanged() });

  const runnable = recipes.filter((r) => r.placeholders.length === 0);
  const problem =
    name.trim().length === 0 ? "Give it a name." : picked.length === 0 ? "Pick at least one recipe." : null;

  return (
    <Decide
      title="Workflows"
      meta={
        <Button
          size="sm"
          variant={open ? "quiet" : "primary"}
          disabled={runnable.length === 0}
          onClick={() => setOpen(!open)}
          {...(runnable.length === 0 ? { title: "Create a recipe with no blanks first" } : {})}
        >
          {open ? "Cancel" : "New workflow"}
        </Button>
      }
    >
      <p style={{ color: "var(--fg-muted)" }}>
        An ordered set of recipes and something that starts them. A workflow prepares work and starts the first
        step of it — it never merges.
      </p>

      {open && (
        <Card>
          <Stack gap="var(--s4)">
            <Field label="Name">
              <Input value={name} onChange={setName} placeholder="Nightly test tidy" />
            </Field>

            <Field label="Recipes to run, in order">
              <Stack gap="var(--s1)">
                {runnable.map((r) => (
                  <label key={r.id} style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={picked.includes(r.id)}
                      onChange={(e) =>
                        setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))
                      }
                    />
                    <span>{r.name}</span>
                  </label>
                ))}
              </Stack>
            </Field>

            <Field label="What starts it">
              <Row gap="var(--s2)" wrap>
                {(["schedule", "event", "manual"] as const).map((k) => (
                  <Button key={k} size="sm" variant={kind === k ? "primary" : "quiet"} onClick={() => setKind(k)}>
                    {k === "schedule" ? "On a schedule" : k === "event" ? "When something happens" : "Only by hand"}
                  </Button>
                ))}
              </Row>
            </Field>

            {kind === "schedule" && (
              <Row gap="var(--s2)" wrap>
                {(["hour", "day", "week"] as const).map((e) => (
                  <Button key={e} size="sm" variant={every === e ? "primary" : "quiet"} onClick={() => setEvery(e)}>
                    every {e}
                  </Button>
                ))}
                {every !== "hour" && (
                  <div style={{ width: 90 }}>
                    <Input value={atHour} onChange={setAtHour} placeholder="hour" mono />
                  </div>
                )}
              </Row>
            )}

            {kind === "event" && (
              <Row gap="var(--s2)" wrap>
                {(["step_merged", "run_failed", "rules_proposed", "quota_reset"] as const).map((e) => (
                  <Button key={e} size="sm" variant={event === e ? "primary" : "quiet"} onClick={() => setEvent(e)}>
                    {describeTrigger({ kind: "event", event: e })}
                  </Button>
                ))}
              </Row>
            )}

            <Row gap="var(--s3)" wrap>
              <Button variant="primary" disabled={problem !== null || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : "Save workflow"}
              </Button>
              <span style={{ color: "var(--fg-muted)" }}>
                {problem ?? "Saved switched off. You turn it on when you are ready."}
              </span>
            </Row>
            <ErrorNote error={save.error} onDismiss={() => save.reset()} />
          </Stack>
        </Card>
      )}

      <ErrorNote error={runNow.error} onDismiss={() => runNow.reset()} />

      {workflows.length === 0 ? (
        <EmptyState
          title="No workflows yet"
          body={
            runnable.length === 0
              ? "Create a recipe with no blanks first — a workflow can only run recipes that need nothing filled in."
              : "A workflow runs your recipes on a schedule, or when something happens."
          }
        />
      ) : (
        <Card padding="0">
          {workflows.map((w, i) => (
            <div key={w.id}>
              {i > 0 && <RowDivider />}
              <Row justify="space-between" wrap gap="var(--s3)" style={{ padding: "var(--s3)" }}>
                <Row gap="var(--s3)" style={{ minWidth: 0 }}>
                  <Dot tone={w.enabled ? "ok" : "idle"} />
                  <Stack gap="2px" style={{ minWidth: 0 }}>
                    <Row gap="var(--s2)" wrap>
                      <strong>{w.name}</strong>
                      {!w.enabled && <Badge tone="idle">off</Badge>}
                    </Row>
                    <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
                      {describeTrigger(w.trigger)} · {w.steps.map((s) => s.recipeName).join(" → ")}
                    </span>
                    {w.lastFiredAt && (
                      <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
                        last fired <RelativeTime iso={w.lastFiredAt} />
                      </span>
                    )}
                  </Stack>
                </Row>
                <Row gap="var(--s2)" style={{ flex: "0 0 auto" }}>
                  <Button size="sm" disabled={runNow.isPending} onClick={() => runNow.mutate(w.id)}>
                    Run now
                  </Button>
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate({ id: w.id, enabled: !w.enabled })}
                  >
                    {w.enabled ? "Switch off" : "Switch on"}
                  </Button>
                  <ConfirmButton
                    question="Delete this workflow?"
                    confirmLabel="Delete"
                    onConfirm={() => remove.mutate(w.id)}
                  >
                    Delete
                  </ConfirmButton>
                </Row>
              </Row>
            </div>
          ))}
        </Card>
      )}

      <Forensics id="automations.limits" label="What automation is not allowed to do">
        <Stack gap="var(--s2)" style={{ padding: "var(--s3)" }}>
          <span>
            <strong>It never merges.</strong> A workflow prepares work and approves the first signature so it
            starts. The merge always waits for you.
          </span>
          <span>
            <strong>It starts one step per feature.</strong> The rest stay queued, so a single trigger cannot
            use up your whole Claude quota.
          </span>
          <span>
            <strong>It stops a chain that feeds itself.</strong> A workflow will not react to an event its own
            run caused, and a cascade stops at a depth limit.
          </span>
          <span>
            <strong>It refuses templates.</strong> A recipe with blanks cannot run unattended, because there is
            nobody there to fill them in.
          </span>
          <Row>
            <Button size="sm" variant="quiet" onClick={() => navigate({ view: "runs" })}>
              see the runs it produced →
            </Button>
          </Row>
        </Stack>
      </Forensics>
    </Decide>
  );
}
