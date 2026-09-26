// Create a feature: the one interrogation.
//
// This is the only place the operator writes prose, and everything downstream is
// frozen from it — so the form explains what each field will be used for rather
// than just labelling it. Validation is specific and appears before the submit
// rather than as a rejection after it.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api.js";
import { navigate } from "../router.js";
import { Badge, Button, Card, Field, Input, Row, SectionTitle, Stack, TextArea } from "../ui/primitives.js";
import { ErrorNote, useToast } from "../ui/feedback.js";

interface DraftStep {
  title: string;
  surface: string;
}

export function NewFeature() {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [incs, setIncs] = useState<DraftStep[]>([{ title: "", surface: "" }]);
  const toast = useToast();

  const usable = incs.filter((i) => i.title.trim() && i.surface.trim());
  const create = useMutation({
    mutationFn: () =>
      api.createFeature({
        title: title.trim(),
        briefMd: brief.trim(),
        increments: usable.map((i) => ({
          title: i.title.trim(),
          declaredSurface: i.surface
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        })),
      }),
    onSuccess: (r) => {
      toast.push("Feature created — approve a step to start", "ok");
      navigate({ view: "feature", id: r.featureId });
    },
  });

  // Say what is missing, not just that something is.
  const problem =
    title.trim().length === 0
      ? "Give the feature a title."
      : brief.trim().length < 20
        ? "This is what Signet works from — a sentence or two at minimum, with an example if you can."
        : usable.length === 0
          ? "Add at least one step, with a name and the files it may change."
          : null;

  return (
    <Stack gap="var(--s5)" style={{ maxWidth: 820 }}>
      <Row justify="space-between">
        <h1 style={{ fontSize: "var(--fs-xl)" }}>New feature</h1>
        <Button variant="quiet" onClick={() => navigate({ view: "work" })}>
          ← all work
        </Button>
      </Row>

      <Card>
        <Stack gap="var(--s4)">
          <Field label="Title" hint="How it appears on the board.">
            <Input value={title} onChange={setTitle} placeholder="Cart: discount support" />
          </Field>

          <Field
            label="What you want built"
            hint="Describe it, with an example if you have one. This is saved as-is the moment you create the feature, and everything Signet builds is judged against it — so it is worth being concrete now rather than in a follow-up."
          >
            <TextArea
              value={brief}
              onChange={setBrief}
              rows={7}
              mono
              placeholder={
                "Add withDiscount(items, percent) to cart.mjs, returning the total with the percentage taken off.\n\nExample: withDiscount([{price:100}], 10) === 90"
              }
            />
          </Field>
        </Stack>
      </Card>

      <Card>
        <Stack gap="var(--s3)">
          <SectionTitle
            action={
              <Button size="sm" onClick={() => setIncs([...incs, { title: "", surface: "" }])}>
                + step
              </Button>
            }
          >
            Steps
          </SectionTitle>
          <p style={{ color: "var(--fg-muted)" }}>
            Break the work into steps. Each one is a single pull request that Signet builds, checks and
            asks you to merge. Listing the files a step may change keeps it honest — anything outside
            that list is caught automatically instead of being reviewed on trust.
          </p>

          <Stack gap="var(--s2)">
            {incs.map((inc, i) => (
              <Row key={i} gap="var(--s2)" align="center">
                <span style={{ color: "var(--fg-subtle)", width: 18, fontFamily: "var(--mono)" }}>{i + 1}</span>
                <div style={{ flex: "1 1 200px" }}>
                  <Input
                    value={inc.title}
                    placeholder="What this step does"
                    onChange={(v) => setIncs(incs.map((x, j) => (j === i ? { ...x, title: v } : x)))}
                  />
                </div>
                <div style={{ flex: "1 1 200px" }}>
                  <Input
                    value={inc.surface}
                    placeholder="cart.mjs, *.test.mjs"
                    mono
                    onChange={(v) => setIncs(incs.map((x, j) => (j === i ? { ...x, surface: v } : x)))}
                  />
                </div>
                <Button
                  variant="quiet"
                  disabled={incs.length === 1}
                  onClick={() => setIncs(incs.filter((_, j) => j !== i))}
                  title={incs.length === 1 ? "A feature needs at least one step" : "Remove"}
                >
                  ✕
                </Button>
              </Row>
            ))}
          </Stack>
        </Stack>
      </Card>

      <ErrorNote error={create.error} onDismiss={() => create.reset()} />

      <Row gap="var(--s3)" wrap>
        <Button variant="primary" disabled={problem !== null || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Creating…" : "Create feature"}
        </Button>
        {problem ? (
          <span style={{ color: "var(--fg-muted)" }}>{problem}</span>
        ) : (
          <Badge tone="ok">
            {usable.length} step{usable.length === 1 ? "" : "s"} ready
          </Badge>
        )}
      </Row>
    </Stack>
  );
}
