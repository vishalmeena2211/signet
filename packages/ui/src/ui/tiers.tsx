// Information tiers: what the console shows, what it subordinates, and what it
// keeps out of the way until asked.
//
// The console had no tiers at all. Every section used one heading treatment and
// everything was always visible, so a screen with nine blocks presented nine
// equally important things — which means it presented nothing. An operator scanning
// for "what needs me" had to read the whole page to find it.
//
// Three tiers, applied on every screen:
//
//   DECIDE      What the operator acts on. One per screen. Gets the focal weight,
//               is never collapsed, and sits above everything else.
//   UNDERSTAND  The evidence behind that decision — gate findings, the diff, the
//               design that was approved. Visible but visibly subordinate.
//   FORENSICS   Raw state, identifiers, journalled effects, pack manifests. Real
//               information, wanted rarely, and noise the other 95% of the time.
//               Collapsed by default, and remembered once opened.
//
// Deliberately NOT more boxes. The grouping comes from heading weight, rhythm and
// disclosure — adding a bordered card per group is what made the console look
// machine-built in the first place.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Row, Stack } from "./primitives.js";

/**
 * A screen's focal section. One per screen — if a second one appears, the screen
 * has two subjects and should probably be two screens.
 */
export function Decide({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack gap="var(--s3)">
      <Row justify="space-between" wrap gap="var(--s3)" style={{ alignItems: "baseline" }}>
        <h2 style={{ fontSize: "var(--fs-lg)", letterSpacing: "-0.01em" }}>{title}</h2>
        {meta}
      </Row>
      {children}
    </Stack>
  );
}

/**
 * Supporting context. Smaller and quieter than Decide, so the eye reaches the
 * focal section first even on a long screen.
 */
export function Understand({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack gap="var(--s2)">
      <Row justify="space-between" wrap gap="var(--s3)" style={{ alignItems: "baseline" }}>
        <h3
          style={{
            fontSize: "var(--fs-sm)",
            fontWeight: 500,
            color: "var(--fg-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {title}
        </h3>
        {meta}
      </Row>
      {children}
    </Stack>
  );
}

/**
 * Disclosure whose open state survives navigation and polling.
 *
 * Local component state was not enough: these screens refetch every few seconds
 * and remount on route changes, so an operator who opened the raw state to read it
 * would find it closed again. Persisting per key means "I want to see effects" is a
 * preference, not a gesture repeated on every visit.
 */
export function useDisclosure(key: string, defaultOpen = false): [boolean, () => void] {
  const storageKey = `signet.open.${key}`;
  const [open, setOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem(storageKey);
    return saved === null ? defaultOpen : saved === "1";
  });
  useEffect(() => {
    localStorage.setItem(storageKey, open ? "1" : "0");
  }, [storageKey, open]);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  return [open, toggle];
}

/**
 * Tier three. Labelled with what is inside and how much of it, so opening it is an
 * informed choice rather than a gamble — "3 effects" tells you whether it is worth
 * the click.
 */
export function Forensics({
  id,
  label,
  count,
  children,
  defaultOpen = false,
}: {
  /** Stable across renders and routes — it keys the remembered open state. */
  id: string;
  label: string;
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, toggle] = useDisclosure(id, defaultOpen);
  return (
    <Stack gap="var(--s2)">
      <button
        onClick={toggle}
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--s2)",
          background: "none",
          border: "none",
          padding: 0,
          color: "var(--fg-subtle)",
          fontSize: "var(--fs-sm)",
          cursor: "pointer",
          justifySelf: "start",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform var(--dur)",
            fontSize: "9px",
          }}
        >
          ▶
        </span>
        {label}
        {count !== undefined && <span className="num">({count})</span>}
      </button>
      {open && children}
    </Stack>
  );
}

/**
 * The one number a screen is about, at a size that makes it the first thing read.
 * Everything else on the screen is smaller by construction.
 */
export function FocalMetric({
  label,
  value,
  hint,
  tone = "var(--fg)",
  action,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: string;
  action?: ReactNode;
}) {
  return (
    <Row justify="space-between" wrap gap="var(--s4)" style={{ alignItems: "flex-end" }}>
      <Stack gap="var(--s1)">
        <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>{label}</span>
        <Row gap="var(--s3)" style={{ alignItems: "baseline" }}>
          <span
            className="num"
            style={{ fontSize: "var(--fs-2xl)", fontWeight: 500, color: tone, letterSpacing: "-0.02em" }}
          >
            {value}
          </span>
          {hint && <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>{hint}</span>}
        </Row>
      </Stack>
      {action}
    </Row>
  );
}

/**
 * Subordinate numbers, on one line. These are glanceable context for the focal
 * metric — not six equal cards competing with it, which is what they were.
 */
export function MetricStrip({
  items,
}: {
  items: readonly { label: string; value: ReactNode; hint?: string }[];
}) {
  return (
    <Row gap="var(--s6)" wrap style={{ alignItems: "baseline" }}>
      {items.map((m) => (
        <Stack key={m.label} gap="2px">
          <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)" }}>{m.label}</span>
          <Row gap="var(--s2)" style={{ alignItems: "baseline" }}>
            <span className="num" style={{ fontSize: "var(--fs-lg)", letterSpacing: "-0.01em" }}>
              {m.value}
            </span>
            {m.hint && <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)" }}>{m.hint}</span>}
          </Row>
        </Stack>
      ))}
    </Row>
  );
}

/** A hairline rule for separating rows within one surface, instead of a card each. */
export function RowDivider() {
  return <span aria-hidden style={{ display: "block", height: 1, background: "var(--line)" }} />;
}
