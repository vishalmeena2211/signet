// Shared pieces every screen needs: a failure you can read, a query that can
// fail visibly, and the collapsible section. Kept here so no screen invents its
// own way of telling the user something went wrong.

import { useState, type ReactNode } from "react";
import { errorText } from "./api.js";

/** A failure, in words, where the action that caused it happened. */
export function ErrorNote({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      style={{
        border: "1px solid var(--fail)",
        background: "color-mix(in srgb, var(--fail) 10%, transparent)",
        borderRadius: "var(--radius-sm)",
        padding: "var(--space-2) var(--space-3)",
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--space-3)",
        justifyContent: "space-between",
      }}
    >
      <span style={{ color: "var(--fail)" }}>{errorText(error)}</span>
      {onDismiss && (
        <button onClick={onDismiss} style={{ padding: "0 var(--space-2)", border: "none", background: "none", color: "var(--text-dim)" }}>
          dismiss
        </button>
      )}
    </div>
  );
}

/**
 * Whole-screen states. Without this a fetch failure renders "Loading…"
 * forever, which reads as a hung app rather than a server that is down.
 */
export function QueryState({
  isPending,
  error,
  onRetry,
  children,
}: {
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (error) {
    return (
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-8) var(--space-4)", display: "grid", gap: "var(--space-4)" }}>
        <h1 style={{ fontSize: "var(--fs-xl)", margin: 0 }}>Cannot reach the Signet core</h1>
        <ErrorNote error={error} />
        <p style={{ color: "var(--text-dim)", margin: 0 }}>
          The console is served by core, so if this persists the API is down or the database is not
          running. Start it with <code>pnpm console</code> from the repo root.
        </p>
        <button className="primary" onClick={onRetry} style={{ justifySelf: "start" }}>
          Try again
        </button>
      </div>
    );
  }
  if (isPending) {
    return <div style={{ padding: "var(--space-8)", color: "var(--text-dim)" }}>Loading…</div>;
  }
  return <>{children}</>;
}

export function Disclosure({
  label,
  count,
  children,
  defaultOpen = false,
}: {
  label: string;
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      <button onClick={() => setOpen(!open)} style={{ justifySelf: "start" }}>
        {open ? "▾" : "▸"} {label}
        {count !== undefined ? ` (${count})` : ""}
      </button>
      {open && children}
    </div>
  );
}
