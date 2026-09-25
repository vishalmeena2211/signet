// Screen 3: create a feature — title, brief, and one-or-more increments each
// with a declared surface. This replaces the seed script: work starts here.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api.js";

interface DraftIncrement {
  title: string;
  surface: string;
}

export function NewFeature({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [incs, setIncs] = useState<DraftIncrement[]>([{ title: "", surface: "" }]);

  const create = useMutation({
    mutationFn: () =>
      api.createFeature({
        title,
        briefMd: brief,
        increments: incs
          .filter((i) => i.title.trim() && i.surface.trim())
          .map((i) => ({
            title: i.title.trim(),
            declaredSurface: i.surface.split(",").map((s) => s.trim()).filter(Boolean),
          })),
      }),
    onSuccess: (r) => onCreated(r.featureId),
  });

  const valid =
    title.trim().length > 0 &&
    brief.trim().length > 0 &&
    incs.some((i) => i.title.trim() && i.surface.trim());

  const field = {
    width: "100%",
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text)",
    padding: "var(--space-2) var(--space-3)",
    font: "inherit",
  } as const;

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-8) var(--space-4)" }}>
      <button onClick={onCancel} style={{ marginBottom: "var(--space-4)" }}>
        ← board
      </button>
      <h1 style={{ fontSize: "var(--fs-xl)", margin: 0 }}>New feature</h1>

      <div style={{ display: "grid", gap: "var(--space-4)", marginTop: "var(--space-6)" }}>
        <label style={{ display: "grid", gap: "var(--space-1)" }}>
          <span style={{ color: "var(--text-dim)" }}>Title</span>
          <input style={field} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Cart: discount support" />
        </label>

        <label style={{ display: "grid", gap: "var(--space-1)" }}>
          <span style={{ color: "var(--text-dim)" }}>
            Brief — what to build, examples included. This becomes the frozen ground truth the agent works from.
          </span>
          <textarea
            style={{ ...field, minHeight: 140, fontFamily: "var(--mono)", fontSize: "var(--fs-sm)" }}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder={"Add withDiscount(items, percent) to cart.mjs …\nExample: withDiscount([{price:100}], 10) === 90"}
          />
        </label>

        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          <span style={{ color: "var(--text-dim)" }}>
            Increments — each is one PR-sized unit. Surface = comma-separated files/globs the agent may touch.
          </span>
          {incs.map((inc, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "var(--space-2)" }}>
              <input
                style={field}
                value={inc.title}
                placeholder={`Increment ${i + 1} title`}
                onChange={(e) => setIncs(incs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
              />
              <input
                style={field}
                value={inc.surface}
                placeholder="cart.mjs, *.test.mjs"
                onChange={(e) => setIncs(incs.map((x, j) => (j === i ? { ...x, surface: e.target.value } : x)))}
              />
              <button onClick={() => setIncs(incs.filter((_, j) => j !== i))} disabled={incs.length === 1}>
                ✕
              </button>
            </div>
          ))}
          <button onClick={() => setIncs([...incs, { title: "", surface: "" }])} style={{ justifySelf: "start" }}>
            + increment
          </button>
        </div>

        {create.isError && <div style={{ color: "var(--fail)" }}>{String(create.error)}</div>}

        <button className="primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Creating…" : "Create feature"}
        </button>
      </div>
    </div>
  );
}
