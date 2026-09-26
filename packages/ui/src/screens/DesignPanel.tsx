// The design of record: the approved visual ground truth for one increment.
//
// This is the thing the conformance gate judges against, so it has to be
// approvable from here — and it has to be legible afterwards, because when the
// gate blocks a merge the first question is always "what did I approve?".
//
// The approval is a human signature: once recorded, it beats the brief. The
// panel says so out loud rather than leaving the user to discover it when an
// agent ignores a colour the brief asked for.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DesignOfRecord } from "@signet/contracts";
import { api } from "../api.js";
import { ErrorNote } from "../components.js";

const HEX = /^#[0-9a-f]{6}$/i;

function parseList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function DesignPanel({ incrementId, editable }: { incrementId: string; editable: boolean }) {
  const qc = useQueryClient();
  const design = useQuery({
    queryKey: ["design", incrementId],
    queryFn: () => api.design(incrementId),
  });
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
      <div style={{ color: "var(--text-dim)", display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
        <span>No design of record — the conformance gate will skip this increment.</span>
        {editable && <button onClick={() => setEditing(true)}>Set a design of record</button>}
      </div>
    );
  }
  return <DesignForm incrementId={incrementId} existing={record} onSaved={onSaved} onCancel={() => setEditing(false)} />;
}

function ApprovedDesign({ record, onReopen }: { record: DesignOfRecord; onReopen?: (() => void) | undefined }) {
  const { intent } = record;
  return (
    <div
      style={{
        border: "1px solid var(--accent)",
        borderRadius: "var(--radius-sm)",
        padding: "var(--space-3)",
        display: "grid",
        gap: "var(--space-2)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)" }}>
        <strong style={{ color: "var(--accent)" }}>Design of record</strong>
        <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>
          {record.source === "ingested" ? "from a provided design" : "resolved from the design system"} · approved by{" "}
          {record.approvedBy}
        </span>
      </div>

      {intent.palette.length > 0 && (
        <Row label="Allowed palette">
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
            {intent.palette.map((c) => (
              <Swatch key={c} color={c} />
            ))}
            <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>tolerance ΔE {intent.maxDeltaE}</span>
          </div>
        </Row>
      )}
      {intent.forbiddenColors.length > 0 && (
        <Row label="Forbidden colours">
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            {intent.forbiddenColors.map((c) => (
              <Swatch key={c} color={c} struck />
            ))}
          </div>
        </Row>
      )}
      {intent.requiredAssets.length > 0 && (
        <Row label="Required assets">
          <code>{intent.requiredAssets.join(", ")}</code>
        </Row>
      )}
      {intent.forbiddenAssets.length > 0 && (
        <Row label="Forbidden assets">
          <code>{intent.forbiddenAssets.join(", ")}</code>
        </Row>
      )}
      {intent.notes && <Row label="Notes">{intent.notes}</Row>}

      <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>
        This is a signature: where it conflicts with the brief, the design of record wins, and the
        conformance gate blocks a merge that diverges from it.
      </div>
      {onReopen && (
        <button onClick={onReopen} style={{ justifySelf: "start" }}>
          Amend
        </button>
      )}
    </div>
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
  const [palette, setPalette] = useState((existing?.intent.palette ?? []).join(", "));
  const [forbiddenColors, setForbiddenColors] = useState((existing?.intent.forbiddenColors ?? []).join(", "));
  const [forbiddenAssets, setForbiddenAssets] = useState((existing?.intent.forbiddenAssets ?? []).join(", "));
  const [requiredAssets, setRequiredAssets] = useState((existing?.intent.requiredAssets ?? []).join(", "));
  const [maxDeltaE, setMaxDeltaE] = useState(String(existing?.intent.maxDeltaE ?? 8));
  const [notes, setNotes] = useState(existing?.intent.notes ?? "");

  const allColors = [...parseList(palette), ...parseList(forbiddenColors)];
  const badColor = allColors.find((c) => !HEX.test(c));
  const deltaE = Number(maxDeltaE);
  const invalid =
    badColor !== undefined
      ? `"${badColor}" is not a 6-digit hex colour like #6609be.`
      : !Number.isFinite(deltaE) || deltaE < 0
        ? "Tolerance must be a number of ΔE units (8 is a good default)."
        : parseList(palette).length === 0 && parseList(forbiddenColors).length === 0 && parseList(forbiddenAssets).length === 0
          ? "Give the gate something to judge: at least one allowed colour, forbidden colour, or forbidden asset."
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
    onSuccess: onSaved,
  });

  return (
    <div
      style={{
        border: "1px solid var(--accent)",
        borderRadius: "var(--radius-sm)",
        padding: "var(--space-3)",
        display: "grid",
        gap: "var(--space-3)",
      }}
    >
      <strong style={{ color: "var(--accent)" }}>
        {existing ? "Amend the design of record" : "Approve a design of record"}
      </strong>

      <Field
        label="Allowed palette"
        hint="Hex colours the build may use. Anything perceptually further than the tolerance is a divergence."
        value={palette}
        onChange={setPalette}
        placeholder="#6609be, #ffffff"
      />
      <Field
        label="Tolerance (ΔE)"
        hint="Perceptual distance, CIE76. 8 catches a wrong brand colour without flagging anti-aliasing."
        value={maxDeltaE}
        onChange={setMaxDeltaE}
        placeholder="8"
      />
      <Field
        label="Forbidden colours"
        hint="Named and blocked outright — useful when a brief asks for something off-brand."
        value={forbiddenColors}
        onChange={setForbiddenColors}
        placeholder="#ff5722"
      />
      <Field
        label="Forbidden assets"
        hint="Paths that must not be referenced, e.g. a superseded logo."
        value={forbiddenAssets}
        onChange={setForbiddenAssets}
        placeholder="public/logo/logo.svg"
      />
      <Field
        label="Required assets"
        hint="Paths the change must reference."
        value={requiredAssets}
        onChange={setRequiredAssets}
        placeholder="public/logo/logo-new.png"
      />
      <Field label="Notes" hint="Carried into the agent's context pack verbatim." value={notes} onChange={setNotes} placeholder="Brand purple only." />

      {invalid && <div style={{ color: "var(--warn)" }}>{invalid}</div>}
      <ErrorNote error={save.error} onDismiss={() => save.reset()} />

      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <button className="primary" disabled={invalid !== null || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Approving…" : "Approve design"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
      <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>
        Approving puts this in the agent's context pack before it writes code, and arms the
        conformance gate to block a divergent merge.
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label style={{ display: "grid", gap: "var(--space-1)" }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>{hint}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          color: "var(--text)",
          padding: "var(--space-2)",
          font: "inherit",
        }}
      />
    </label>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, auto) 1fr", gap: "var(--space-3)", alignItems: "center" }}>
      <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-sm)" }}>{label}</span>
      <div>{children}</div>
    </div>
  );
}

function Swatch({ color, struck = false }: { color: string; struck?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
      <span
        aria-hidden
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          background: color,
          border: "1px solid var(--border)",
          display: "inline-block",
        }}
      />
      <code style={{ textDecoration: struck ? "line-through" : "none" }}>{color}</code>
    </span>
  );
}
