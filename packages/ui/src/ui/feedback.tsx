// Telling the user what happened: errors, emptiness, loading, confirmation, and
// the drawer that shows detail without losing your place.
//
// The governing rule is that no outcome is silent. An action either shows its
// result or shows why it could not happen; a screen either shows data, or says
// it is loading, or says what went wrong and offers a way out.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { errorText } from "../api.js";
import { Button, Card, Row, Stack, TONE, type Tone } from "./primitives.js";

// ── errors ──

export function ErrorNote({
  error,
  onDismiss,
  onRetry,
}: {
  error: unknown;
  onDismiss?: () => void;
  onRetry?: () => void;
}) {
  if (!error) return null;
  return (
    <div
      role="alert"
      style={{
        border: "1px solid var(--err)",
        background: "var(--err-quiet)",
        borderRadius: "var(--r-sm)",
        padding: "var(--s2) var(--s3)",
        display: "flex",
        gap: "var(--s3)",
        alignItems: "flex-start",
        justifyContent: "space-between",
      }}
    >
      <span style={{ color: "var(--err)", overflowWrap: "anywhere" }}>{errorText(error)}</span>
      <Row gap="var(--s1)">
        {onRetry && (
          <Button size="sm" variant="quiet" onClick={onRetry}>
            retry
          </Button>
        )}
        {onDismiss && (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            dismiss
          </Button>
        )}
      </Row>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <Card style={{ padding: "var(--s10)", textAlign: "center" }}>
      <Stack gap="var(--s2)">
        <strong style={{ fontSize: "var(--fs-md)" }}>{title}</strong>
        {body && <p style={{ color: "var(--fg-muted)", margin: "0 auto", maxWidth: 460 }}>{body}</p>}
        {action && <div style={{ marginTop: "var(--s2)" }}>{action}</div>}
      </Stack>
    </Card>
  );
}

/** Rows of shimmer while a screen loads, so layout does not jump on arrival. */
export function Skeleton({ rows = 3, height = 44 }: { rows?: number; height?: number }) {
  return (
    <Stack gap="var(--s2)">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{
            height,
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-sm)",
            animation: "signet-pulse 1.6s ease-in-out infinite",
            animationDelay: `${i * 90}ms`,
          }}
        />
      ))}
    </Stack>
  );
}

/**
 * The three states of a query, handled once. A screen that renders on `data?`
 * alone shows "loading" forever when the server is down, which reads as a frozen
 * app rather than a reachable problem.
 */
export function QueryState({
  isPending,
  error,
  onRetry,
  skeletonRows,
  children,
}: {
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  skeletonRows?: number;
  children: ReactNode;
}) {
  if (error) {
    return (
      <Stack>
        <ErrorNote error={error} onRetry={onRetry} />
        <p style={{ color: "var(--fg-muted)" }}>
          The console is served by core, so if this persists the API is down or the database is not
          running. Start everything with <code>pnpm console</code> from the repo root.
        </p>
      </Stack>
    );
  }
  if (isPending) return <Skeleton rows={skeletonRows ?? 3} />;
  return <>{children}</>;
}

// ── toasts ──

interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

const ToastCtx = createContext<{ push: (message: string, tone?: Tone) => void }>({ push: () => {} });

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const push = useCallback((message: string, tone: Tone = "neutral") => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-4), { id, message, tone }]);
    // Errors stay longer: they are likelier to matter and likelier to be missed.
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "err" ? 8000 : 4000);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        style={{
          position: "fixed",
          right: "var(--s4)",
          bottom: "var(--s4)",
          display: "grid",
          gap: "var(--s2)",
          zIndex: 60,
          maxWidth: 380,
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background: "var(--overlay)",
              border: `1px solid ${t.tone === "neutral" ? "var(--line-strong)" : TONE[t.tone].fg}`,
              borderLeftWidth: 3,
              borderRadius: "var(--r-sm)",
              padding: "var(--s2) var(--s3)",
              boxShadow: "var(--shadow-2)",
              fontSize: "var(--fs)",
              animation: "signet-slide-in 140ms ease-out",
            }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ── drawer ──

/**
 * Detail without navigation. Inspecting a run from a list should not throw away
 * the list, its filters or its scroll position — so detail slides over it and
 * Escape puts it back.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  width = 720,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  width?: number;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "var(--scrim)", zIndex: 50 }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: `min(${width}px, 92vw)`,
          background: "var(--overlay)",
          borderLeft: "1px solid var(--line-strong)",
          boxShadow: "var(--shadow-3)",
          zIndex: 51,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            padding: "var(--s3) var(--s4)",
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "var(--s3)",
          }}
        >
          <Stack gap="2px">
            <strong style={{ fontSize: "var(--fs-md)" }}>{title}</strong>
            {subtitle && <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>{subtitle}</span>}
          </Stack>
          <Button size="sm" variant="quiet" onClick={onClose} title="Close (Esc)">
            ✕
          </Button>
        </header>
        <div style={{ padding: "var(--s4)", overflow: "auto", flex: 1 }}>{children}</div>
      </aside>
    </>
  );
}

/**
 * Confirmation for the irreversible. Merging and aborting change the world
 * outside the console, so they are worth one deliberate click — but nothing else
 * is, and asking everywhere would train people to click through.
 */
export function ConfirmButton({
  children,
  confirmLabel,
  question,
  onConfirm,
  variant = "primary",
  disabled = false,
}: {
  children: ReactNode;
  confirmLabel: string;
  question: string;
  onConfirm: () => void;
  variant?: "primary" | "danger";
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    // Disarm on a timer: a half-pressed destructive button left lying around is
    // worse than one that makes you start again.
    const t = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(t);
  }, [armed]);

  if (!armed) {
    return (
      <Button variant={variant} disabled={disabled} onClick={() => setArmed(true)}>
        {children}
      </Button>
    );
  }
  return (
    <Row gap="var(--s2)" wrap>
      <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>{question}</span>
      <Button variant={variant} onClick={onConfirm}>
        {confirmLabel}
      </Button>
      <Button variant="quiet" onClick={() => setArmed(false)}>
        cancel
      </Button>
    </Row>
  );
}
