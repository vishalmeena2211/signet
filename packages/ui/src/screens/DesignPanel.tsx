// The design of record: the approved visual ground truth for one increment.
//
// This is what the conformance gate judges against, which makes it the product's
// differentiator — so it has to be approvable from here, and legible afterwards,
// because when a merge is blocked the first question is always "what did I
// approve?".
//
// The approval is a signature: once recorded it beats the brief. The panel says
// so out loud rather than leaving someone to discover it when an agent ignores a
// colour the brief asked for.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DesignOfRecord } from "@signet/contracts";
import { api } from "../api.js";
import { Badge, Button, Card, Detail, Field, Input, Row, Stack, TextArea } from "../ui/primitives.js";
import { ErrorNote, useToast } from "../ui/feedback.js";
import { RelativeTime } from "../ui/format.js";

const HEX = /^#[0-9a-f]{6}$/i;

function parseList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function DesignPanel({ incrementId, editable }: { incrementId: string; editable: boolean }) {
  const qc = useQueryClient();
  const design = useQuery({ queryKey: ["design", incrementId], queryFn: () => api.design(incrementId) });
  const [editing, setEditing] = useState(false);

  if (design.isPending) return null;
  if (design.error) return <ErrorNote error={design.error} />;

  const record = design.data;
  const onSaved = () => {
    setEditing(false);
    void qc.invalidateQueries({ queryKey: ["design", incrementId] });
    void qc.invalidateQueries({ queryKey: ["feature"] });
  };

  if (record && !editing) {
    return <ApprovedDesign record={record} onReopen={editable ? () => setEditing(true) : undefined} />;
  }
  if (!record && !editing) {
    return (
      <Row gap="var(--s3)" wrap style={{ color: "var(--fg-muted)" }}>
        <span>No design of record — the conformance gate will skip this increment.</span>
        {editable && (
          <Button size="sm" onClick={() => setEditing(true)}>
            Set a design of record
          </Button>
        )}
      </Row>
    );
  }
  return (
    <DesignForm
      incrementId={incrementId}
      existing={record}
      onSaved={onSaved}
      onCancel={() => setEditing(false)}
    />
  );
}

function ApprovedDesign({ record, onReopen }: { record: DesignOfRecord; onReopen?: (() => void) | undefined }) {
  const { intent } = record;
  return (
    <Card tone="accent" padding="var(--s3)">
      <Stack gap="var(--s3)">
        <Row justify="space-between" wrap gap="var(--s3)">
          <strong style={{ color: "var(--accent)" }}>Design of record</strong>
          <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
            {record.source === "ingested" ? "from a provided design" : "resolved from the design system"} · approved by{" "}
            {record.approvedBy} <RelativeTime iso={record.approvedAt} />
          </span>
        </Row>

        <Row gap="var(--s6)" wrap>
          {intent.palette.length > 0 && (
            <Detail label={`Allowed palette · ΔE ${intent.maxDeltaE}`}>
              <Row gap="var(--s2)" wrap>
                {intent.palette.map((c) => (
                  <Swatch key={c} color={c} />
                ))}
              </Row>
            </Detail>
          )}
          {intent.forbiddenColors.length > 0 && (
            <Detail label="Forbidden colours">
              <Row gap="var(--s2)" wrap>
                {intent.forbiddenColors.map((c) => (
                  <Swatch key={c} color={c} struck />
                ))}
              </Row>
            </Detail>
          )}
          {intent.requiredAssets.length > 0 && (
            <Detail label="Required assets" mono>
              {intent.requiredAssets.join(", ")}
            </Detail>
          )}
          {intent.forbiddenAssets.length > 0 && (
            <Detail label="Forbidden assets" mono>
              {intent.forbiddenAssets.join(", ")}
            </Detail>
          )}
        </Row>

        {intent.notes && <span style={{ color: "var(--fg-muted)" }}>{intent.notes}</span>}

        <Row justify="space-between" wrap gap="var(--s2)">
          <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
            Where this conflicts with the brief, the design of record wins — and the conformance gate
            blocks a merge that diverges from it.
          </span>
          {onReopen && (
            <Button size="sm" variant="quiet" onClick={onReopen}>
              amend
            </Button>
          )}
        </Row>
      </Stack>
    </Card>
  );
}

function DesignForm({
  incrementId,
  existing,
  onSaved,
  onCancel,
}: {
  incrementId: string;
  existing: DesignOfRecord | null | undefined;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [palette, setPalette] = useState((existing?.intent.palette ?? []).join(", "));
  const [forbiddenColors, setForbiddenColors] = useState((existing?.intent.forbiddenColors ?? []).join(", "));
  const [forbiddenAssets, setForbiddenAssets] = useState((existing?.intent.forbiddenAssets ?? []).join(", "));
  const [requiredAssets, setRequiredAssets] = useState((existing?.intent.requiredAssets ?? []).join(", "));
  const [maxDeltaE, setMaxDeltaE] = useState(String(existing?.intent.maxDeltaE ?? 8));
  const [notes, setNotes] = useState(existing?.intent.notes ?? "");

  const allColors = [...parseList(palette), ...parseList(forbiddenColors)];
  const badColor = allColors.find((c) => !HEX.test(c));
  const deltaE = Number(maxDeltaE);
  const problem =
    badColor !== undefined
      ? `“${badColor}” is not a 6-digit hex colour like #6609be.`
      : !Number.isFinite(deltaE) || deltaE < 0
        ? "Tolerance is a number of ΔE units — 8 is a good default."
        : allColors.length === 0 && parseList(forbiddenAssets).length === 0 && parseList(requiredAssets).length === 0
          ? "Give the gate something to judge: at least one colour or asset rule."
          : null;

  const save = useMutation({
    mutationFn: () =>
      api.approveDesign(incrementId, {
        source: "resolved",
        approvedBy: "console",
        intent: {
          palette: parseList(palette),
          maxDeltaE: deltaE,
          forbiddenColors: parseList(forbiddenColors),
          requiredAssets: parseList(requiredAssets),
          forbiddenAssets: parseList(forbiddenAssets),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      }),
    onSuccess: () => {
      toast.push("Design approved — it is now in the agent's context pack and armed as a gate", "ok");
      onSaved();
    },
  });

  return (
    <Card tone="accent" padding="var(--s3)">
      <Stack gap="var(--s4)">
        <strong style={{ color: "var(--accent)" }}>
          {existing ? "Amend the design of record" : "Approve a design of record"}
        </strong>

        <Row gap="var(--s3)" wrap align="flex-start">
          <div style={{ flex: "1 1 260px" }}>
            <Field
              label="Allowed palette"
              hint="Hex colours the build may use. Anything perceptually further away than the tolerance is a divergence."
            >
              <Input value={palette} onChange={setPalette} placeholder="#6609be, #ffffff" mono />
            </Field>
          </div>
          <div style={{ flex: "0 0 130px" }}>
            <Field label="Tolerance ΔE" hint="CIE76. 8 catches a wrong brand colour, not anti-aliasing.">
              <Input value={maxDeltaE} onChange={setMaxDeltaE} placeholder="8" mono />
            </Field>
          </div>
        </Row>

        <Row gap="var(--s3)" wrap align="flex-start">
          <div style={{ flex: "1 1 260px" }}>
            <Field label="Forbidden colours" hint="Blocked outright — useful when a brief asks for something off-brand.">
              <Input value={forbiddenColors} onChange={setForbiddenColors} placeholder="#ff5722" mono />
            </Field>
          </div>
          <div style={{ flex: "1 1 260px" }}>
            <Field label="Forbidden assets" hint="Paths that must not be referenced, e.g. a superseded logo.">
              <Input value={forbiddenAssets} onChange={setForbiddenAssets} placeholder="public/logo/logo.svg" mono />
            </Field>
          </div>
        </Row>

        <Row gap="var(--s3)" wrap align="flex-start">
          <div style={{ flex: "1 1 260px" }}>
            <Field label="Required assets" hint="Paths the change must reference.">
              <Input value={requiredAssets} onChange={setRequiredAssets} placeholder="public/logo/logo-new.png" mono />
            </Field>
          </div>
        </Row>

        <Field label="Notes" hint="Carried into the agent's context pack verbatim, before it writes any code.">
          <TextArea value={notes} onChange={setNotes} rows={2} placeholder="Brand purple only." />
        </Field>

        {problem && <span style={{ color: "var(--warn)" }}>{problem}</span>}
        <ErrorNote error={save.error} onDismiss={() => save.reset()} />

        <Row gap="var(--s2)" wrap>
          <Button variant="primary" disabled={problem !== null || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Approving…" : "Approve design"}
          </Button>
          <Button variant="quiet" onClick={onCancel}>
            cancel
          </Button>
          <Badge tone="idle">this is signature-grade: it will block a divergent merge</Badge>
        </Row>
      </Stack>
    </Card>
  );
}

function Swatch({ color, struck = false }: { color: string; struck?: boolean }) {
  return (
    <Row gap="var(--s1)">
      <span
        aria-hidden
        style={{
          width: 13,
          height: 13,
          borderRadius: 3,
          background: color,
          border: "1px solid var(--line-strong)",
          flex: "0 0 auto",
        }}
      />
      <code style={{ textDecoration: struck ? "line-through" : "none" }}>{color}</code>
    </Row>
  );
}
