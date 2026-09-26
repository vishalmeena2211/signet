// Create a feature: say what you want, then review what Signet proposes.
//
// This screen used to ask for the steps AND the file globs each step was allowed to
// touch. Only somebody who already knows the codebase can answer that, and getting it
// wrong is unforgiving — a plan touching a file outside its declared surface is a
// NON-recoverable error, so the run is killed with no repair. Two of the four items in
// the pilot's attention queue were that exact failure: one agent returned an empty file
// list, another needed cart.mjs while the hand-written surface said otherwise.
//
// Both times the agent knew what the work needed and the human's guess did not match.
// So the guessing moves to the side holding the repository: you describe the outcome,
// Signet surveys the repo and proposes the breakdown, and you approve or edit it.
//
// The surfaces do NOT disappear. They are what catches an agent editing outside its
// remit, and dropping the constraint to remove the friction would be throwing away the
// guard instead of fixing the ergonomics. They stay visible and editable — they stop
// being your homework.
//
// A side effect worth naming: signature 1 gets better. Approving prose you wrote thirty
// seconds ago teaches you nothing. Approving a researched plan you have not seen, with
// the repo's real structure behind it, is a decision with information in it.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { FeatureProposalResponse, SurfaceWarning } from "@signet/contracts";
import { api } from "../api.js";
import { navigate } from "../router.js";
import { Badge, Button, Card, Field, Input, Row, SectionTitle, Stack, TextArea } from "../ui/primitives.js";
import { Combobox } from "../ui/combobox.js";
import { ErrorNote, useToast } from "../ui/feedback.js";

/** A proposed step once it is on screen and editable. */
interface DraftStep {
  title: string;
  rationale: string;
  /** Comma-separated for editing; split on submit. */
  surface: string;
  acceptance: string;
}

const WARNING_WORDS: Record<SurfaceWarning["reason"], string> = {
  matches_nothing: "no file in the repo matches this",
  matches_everything: "this hands over the whole repo, which is the same as no limit at all",
  outside_repo: "this points outside the repository",
};

export function NewFeature() {
  const [repoId, setRepoId] = useState("");
  const [goal, setGoal] = useState("");
  const [proposed, setProposed] = useState<FeatureProposalResponse | null>(null);
  const [title, setTitle] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const toast = useToast();

  // Loaded once and cached: scanning the disk is cheap but not free, and the answer
  // does not change while you are filling in a form.
  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repoOptions, staleTime: 60_000 });

  // Default to the repo this instance is configured with — the one that is known to
  // work — rather than leaving the field empty and making the first action a decision.
  const configured = repos.data?.repos.find((r) => r.isConfigured);
  const effectiveRepoId = repoId || configured?.id || "";
  const chosen = repos.data?.repos.find((r) => r.id === effectiveRepoId);

  const propose = useMutation({
    mutationFn: () => api.propose({ goal: goal.trim(), ...(effectiveRepoId ? { repoId: effectiveRepoId } : {}) }),
    onSuccess: (res) => {
      setProposed(res);
      setTitle(res.proposal.title);
      setSteps(
        res.proposal.steps.map((s) => ({
          title: s.title,
          rationale: s.rationale,
          surface: s.declaredSurface.join(", "),
          acceptance: s.acceptanceMd,
        })),
      );
    },
  });

  const usable = steps.filter((s) => s.title.trim() && s.surface.trim() && s.acceptance.trim());

  const create = useMutation({
    mutationFn: () =>
      api.createFeature({
        title: title.trim(),
        ...(effectiveRepoId ? { repoId: effectiveRepoId } : {}),
        briefMd: [
          proposed?.proposal.understanding ?? goal.trim(),
          ...((proposed?.proposal.uncertainties.length ?? 0) > 0
            ? ["", "## Open questions at approval time", ...(proposed?.proposal.uncertainties ?? []).map((u) => `- ${u}`)]
            : []),
        ].join("\n"),
        increments: usable.map((s) => ({
          title: s.title.trim(),
          declaredSurface: s.surface
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          acceptanceMd: s.acceptance.trim(),
        })),
      }),
    onSuccess: (r) => {
      toast.push("Feature created — approve a step to start", "ok");
      navigate({ view: "feature", id: r.featureId });
    },
  });

  const goalProblem =
    goal.trim().length < 20
      ? "Describe the outcome you want, with an example if you have one. A proposal built on half a sentence is a guess wearing a plan's clothing."
      : null;

  return (
    <Stack gap="var(--s5)" style={{ maxWidth: 880 }}>
      <Row justify="space-between">
        <h1 style={{ fontSize: "var(--fs-xl)" }}>New feature</h1>
        <Button variant="quiet" onClick={() => navigate({ view: "work" })}>
          ← all work
        </Button>
      </Row>

      <Card>
        <Stack gap="var(--s4)">
          {/* First question, because it is the one that used to have no answer on screen
              at all: the repo came from an env var nobody reads. Free text stays valid —
              a path you type is as good as one we found. */}
          <Field
            label="Which repo"
            hint={
              repos.data
                ? `${repos.data.repos.filter((r) => r.origin === "local").length} local repos found, plus your GitHub ones. You can also type a path.`
                : "Loading the repositories on this machine…"
            }
          >
            <Combobox
              value={effectiveRepoId}
              onChange={setRepoId}
              mono
              loading={repos.isPending}
              placeholder="~/code/my-project"
              emptyNote="No match. Type an absolute path to use a repo we did not find."
              options={(repos.data?.repos ?? []).map((r) => ({
                value: r.id,
                label: r.label,
                ...(r.isConfigured
                  ? { hint: "this instance's default" }
                  : r.detail
                    ? { hint: r.detail }
                    : {}),
                meta: r.canMerge ? undefined : "plan only",
              }))}
            />
          </Field>

          {/* The limitation is stated where the choice is made. Discovering at the merge
              that Signet cannot push is a bug; being told before you start is a boundary. */}
          {chosen && !chosen.canMerge && (
            <Row gap="var(--s2)" wrap style={{ color: "var(--warn)" }}>
              <Badge tone="warn">plan only</Badge>
              <span>{chosen.limitation}</span>
            </Row>
          )}
          {repos.data?.github.reason && (
            <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
              GitHub repositories are not listed: {repos.data.github.reason}
            </span>
          )}

          <Field
            label="What you want built"
            hint="Describe the outcome, with an example if you have one. Signet reads the repository and comes back with a proposed breakdown for you to approve or change — you do not have to work out the steps or which files they touch."
          >
            <TextArea
              value={goal}
              onChange={setGoal}
              rows={7}
              mono
              placeholder={
                "Add percentage discounts to the shopping cart.\n\nwithDiscount([{price:100}], 10) should total 90. Reject percentages below 0 or above 100."
              }
            />
          </Field>

          <Row gap="var(--s3)" wrap>
            <Button
              variant={proposed ? "quiet" : "primary"}
              disabled={goalProblem !== null || propose.isPending}
              onClick={() => propose.mutate()}
            >
              {propose.isPending ? "Reading your repo…" : proposed ? "Propose again" : "Propose a plan"}
            </Button>
            {goalProblem && <span style={{ color: "var(--fg-muted)" }}>{goalProblem}</span>}
            {propose.isPending && (
              <span style={{ color: "var(--fg-muted)" }}>
                Surveying the repository and working out a breakdown. This takes a few moments and costs one
                model call.
              </span>
            )}
          </Row>
        </Stack>
      </Card>

      <ErrorNote error={propose.error} onDismiss={() => propose.reset()} />

      {proposed && (
        <>
          <Card>
            <Stack gap="var(--s3)">
              <SectionTitle>What Signet understood</SectionTitle>
              {/* Read back before anything is built, for the same reason the brief
                  read-back exists: a misread caught here is free. */}
              <p style={{ whiteSpace: "pre-wrap" }}>{proposed.proposal.understanding}</p>
              <Row gap="var(--s3)" wrap style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
                <span style={{ fontFamily: "var(--mono)" }}>{proposed.repoLabel}</span>
                <span>{proposed.filesSurveyed} files read</span>
                {proposed.surveyTruncated && (
                  <span style={{ color: "var(--warn)" }}>
                    the survey hit its limit, so this plan saw only part of the repo
                  </span>
                )}
              </Row>
            </Stack>
          </Card>

          {proposed.proposal.uncertainties.length > 0 && (
            <Card tone="warn">
              <Stack gap="var(--s2)">
                <SectionTitle>What it was unsure about</SectionTitle>
                {/* Carried rather than hidden. A plan that hides its doubts looks
                    identical to a confident one, and you are the person who can settle
                    them. These are saved with the feature so the decision is recorded. */}
                <ul style={{ margin: 0, paddingLeft: "var(--s4)" }}>
                  {proposed.proposal.uncertainties.map((u, i) => (
                    <li key={i}>{u}</li>
                  ))}
                </ul>
              </Stack>
            </Card>
          )}

          {proposed.surfaceWarnings.length > 0 && (
            <Card tone="err">
              <Stack gap="var(--s2)">
                <SectionTitle>Check these file lists before approving</SectionTitle>
                {/* The single most valuable thing on this screen. A glob matching
                    nothing reads perfectly well and then kills the run it produced. */}
                <p style={{ color: "var(--fg-muted)" }}>
                  Checked against the files that actually exist. A step whose files are wrong will fail as
                  soon as it starts, so it is worth fixing now.
                </p>
                {proposed.surfaceWarnings.map((w, i) => (
                  <Row key={i} gap="var(--s2)" wrap>
                    <Badge tone="err" mono>
                      {w.pattern}
                    </Badge>
                    <span>
                      in “{w.stepTitle}” — {WARNING_WORDS[w.reason]}
                    </span>
                  </Row>
                ))}
              </Stack>
            </Card>
          )}

          <Card>
            <Stack gap="var(--s4)">
              <Field label="Title" hint="How it appears on the board.">
                <Input value={title} onChange={setTitle} />
              </Field>

              <SectionTitle
                action={
                  <Button
                    size="sm"
                    onClick={() =>
                      setSteps([...steps, { title: "", rationale: "added by you", surface: "", acceptance: "" }])
                    }
                  >
                    + step
                  </Button>
                }
              >
                Proposed steps
              </SectionTitle>
              <p style={{ color: "var(--fg-muted)" }}>
                Each step is one pull request that Signet builds, checks and asks you to merge. Everything here
                is editable — the file list is a hard limit, so anything a step tries to change outside it is
                caught automatically rather than reviewed on trust.
              </p>

              <Stack gap="var(--s4)">
                {steps.map((s, i) => (
                  <Stack key={i} gap="var(--s2)" style={{ borderLeft: "2px solid var(--line)", paddingLeft: "var(--s3)" }}>
                    <Row gap="var(--s2)" align="center">
                      <span style={{ color: "var(--fg-subtle)", width: 18, fontFamily: "var(--mono)" }}>{i + 1}</span>
                      <div style={{ flex: 1 }}>
                        <Input
                          value={s.title}
                          placeholder="What this step does"
                          onChange={(v) => setSteps(steps.map((x, j) => (j === i ? { ...x, title: v } : x)))}
                        />
                      </div>
                      <Button
                        variant="quiet"
                        disabled={steps.length === 1}
                        onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                        title={steps.length === 1 ? "A feature needs at least one step" : "Remove"}
                      >
                        ✕
                      </Button>
                    </Row>
                    {s.rationale && (
                      <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>{s.rationale}</span>
                    )}
                    <Field label="Files it may change" hint="Comma separated. Anything outside this fails the step.">
                      <Input
                        value={s.surface}
                        mono
                        onChange={(v) => setSteps(steps.map((x, j) => (j === i ? { ...x, surface: v } : x)))}
                      />
                    </Field>
                    <Field
                      label="Done when"
                      hint="What the checks and the agent are aiming at. Until now this was never filled in, so no run had been told what done meant."
                    >
                      <TextArea
                        value={s.acceptance}
                        rows={3}
                        onChange={(v) => setSteps(steps.map((x, j) => (j === i ? { ...x, acceptance: v } : x)))}
                      />
                    </Field>
                  </Stack>
                ))}
              </Stack>
            </Stack>
          </Card>

          <ErrorNote error={create.error} onDismiss={() => create.reset()} />

          <Row gap="var(--s3)" wrap>
            <Button
              variant="primary"
              disabled={usable.length === 0 || title.trim().length === 0 || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Creating…" : "Create feature"}
            </Button>
            {usable.length === 0 ? (
              <span style={{ color: "var(--fg-muted)" }}>
                Every step needs a name, a file list, and what done means.
              </span>
            ) : (
              <Badge tone="ok">
                {usable.length} step{usable.length === 1 ? "" : "s"} ready
              </Badge>
            )}
          </Row>
        </>
      )}
    </Stack>
  );
}
