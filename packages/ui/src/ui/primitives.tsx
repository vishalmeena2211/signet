// The component vocabulary. Every screen is built from these, so a change here
// is a change everywhere — which is the point: consistency you cannot forget to
// apply. Styling is inline against CSS custom properties rather than a CSS-in-JS
// dependency, because the token layer is already the abstraction and a second
// one would only add build weight.

import type { CSSProperties, ReactNode } from "react";

export type Tone = "neutral" | "accent" | "ok" | "warn" | "err" | "run" | "idle";

/** Semantic tone → the token pair for it. One place, so tones stay consistent. */
export const TONE: Record<Tone, { fg: string; quiet: string }> = {
  neutral: { fg: "var(--fg-muted)", quiet: "transparent" },
  accent: { fg: "var(--accent)", quiet: "var(--accent-quiet)" },
  ok: { fg: "var(--ok)", quiet: "var(--ok-quiet)" },
  warn: { fg: "var(--warn)", quiet: "var(--warn-quiet)" },
  err: { fg: "var(--err)", quiet: "var(--err-quiet)" },
  run: { fg: "var(--run)", quiet: "var(--run-quiet)" },
  idle: { fg: "var(--idle)", quiet: "var(--idle-quiet)" },
};

// ── layout ──

export function Stack({
  gap = "var(--s3)",
  children,
  style,
}: {
  gap?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return <div style={{ display: "grid", gap, ...style }}>{children}</div>;
}

export function Row({
  gap = "var(--s2)",
  align = "center",
  justify,
  wrap = false,
  children,
  style,
}: {
  gap?: string;
  align?: CSSProperties["alignItems"];
  justify?: CSSProperties["justifyContent"];
  wrap?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap,
        alignItems: align,
        ...(justify ? { justifyContent: justify } : {}),
        ...(wrap ? { flexWrap: "wrap" } : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Card({
  children,
  tone = "neutral",
  padding = "var(--s4)",
  style,
}: {
  children: ReactNode;
  tone?: Tone;
  padding?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: "var(--panel)",
        border: `1px solid ${tone === "neutral" ? "var(--line)" : TONE[tone].fg}`,
        borderRadius: "var(--r)",
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <Row justify="space-between" style={{ minHeight: 26 }}>
      <h3 style={{ fontSize: "var(--fs-md)" }}>{children}</h3>
      {action}
    </Row>
  );
}

/** A labelled value: the console's basic unit of read-only information. */
export function Detail({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </span>
      <span
        style={{
          ...(mono ? { fontFamily: "var(--mono)", fontSize: "var(--fs-sm)" } : {}),
          overflowWrap: "anywhere",
        }}
      >
        {children}
      </span>
    </div>
  );
}

// ── controls ──

export type ButtonVariant = "primary" | "default" | "quiet" | "danger";

export function Button({
  children,
  onClick,
  variant = "default",
  disabled = false,
  size = "md",
  title,
  style,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  size?: "sm" | "md";
  title?: string;
  style?: CSSProperties;
  type?: "button" | "submit";
}) {
  const pad = size === "sm" ? "3px var(--s2)" : "6px var(--s3)";
  const look: Record<ButtonVariant, CSSProperties> = {
    primary: { background: "var(--accent)", borderColor: "var(--accent)", color: "var(--fg-inverse)", fontWeight: 600 },
    default: { background: "var(--panel-2)", borderColor: "var(--line)", color: "var(--fg)" },
    quiet: { background: "transparent", borderColor: "transparent", color: "var(--fg-muted)" },
    danger: { background: "transparent", borderColor: "var(--line)", color: "var(--err)" },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--s2)",
        borderWidth: 1,
        borderStyle: "solid",
        borderRadius: "var(--r-sm)",
        padding: pad,
        fontSize: size === "sm" ? "var(--fs-sm)" : "var(--fs)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        whiteSpace: "nowrap",
        transition: "background var(--dur), border-color var(--dur)",
        ...look[variant],
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
  mono = false,
}: {
  children: ReactNode;
  tone?: Tone;
  mono?: boolean;
}) {
  const t = TONE[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        background: t.quiet,
        color: t.fg,
        border: `1px solid ${tone === "neutral" ? "var(--line)" : "transparent"}`,
        borderRadius: "var(--r-sm)",
        padding: "1px 6px",
        fontSize: "var(--fs-xs)",
        fontWeight: 500,
        whiteSpace: "nowrap",
        ...(mono ? { fontFamily: "var(--mono)" } : {}),
      }}
    >
      {children}
    </span>
  );
}

/**
 * A status dot. Paired with a text label at every call site — colour alone is
 * not a status for a reader who cannot distinguish it.
 */
export function Dot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 7,
        height: 7,
        borderRadius: "var(--r-full)",
        background: TONE[tone].fg,
        flex: "0 0 auto",
        ...(pulse ? { animation: "signet-pulse 1.6s ease-in-out infinite" } : {}),
      }}
    />
  );
}

export function Spinner({ size = 13 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        border: "2px solid var(--line-strong)",
        borderTopColor: "var(--accent)",
        borderRadius: "var(--r-full)",
        display: "inline-block",
        animation: "signet-spin 700ms linear infinite",
      }}
    />
  );
}

export function Field({
  label,
  hint,
  children,
  error,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  error?: string | null;
}) {
  return (
    <label style={{ display: "grid", gap: "var(--s1)" }}>
      <span style={{ fontWeight: 500 }}>{label}</span>
      {hint && <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>{hint}</span>}
      {children}
      {error && <span style={{ color: "var(--err)", fontSize: "var(--fs-sm)" }}>{error}</span>}
    </label>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  mono = false,
  onKeyDown,
  autoFocus = false,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
  style?: CSSProperties;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      // eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate: the palette and search fields exist to be typed into immediately
      autoFocus={autoFocus}
      style={{ width: "100%", ...(mono ? { fontFamily: "var(--mono)" } : {}), ...style }}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 4,
  mono = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: "100%", resize: "vertical", ...(mono ? { fontFamily: "var(--mono)" } : {}) }}
    />
  );
}

/** A segmented control: the right shape for 2–5 mutually exclusive filters. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "inline-flex",
        background: "var(--panel-2)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-sm)",
        padding: 2,
        gap: 2,
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            style={{
              border: "none",
              background: on ? "var(--panel-3)" : "transparent",
              color: on ? "var(--fg)" : "var(--fg-muted)",
              borderRadius: 3,
              padding: "3px var(--s2)",
              fontSize: "var(--fs-sm)",
              fontWeight: on ? 600 : 400,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {o.label}
            {o.count !== undefined && (
              <span style={{ color: "var(--fg-subtle)", marginLeft: 6 }}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--s2)",
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: 0,
        fontSize: "var(--fs)",
      }}
    >
      <span
        style={{
          width: 30,
          height: 17,
          borderRadius: "var(--r-full)",
          background: checked ? "var(--accent)" : "var(--line-strong)",
          position: "relative",
          transition: "background var(--dur)",
          flex: "0 0 auto",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 15 : 2,
            width: 13,
            height: 13,
            borderRadius: "var(--r-full)",
            background: "#fff",
            transition: "left var(--dur)",
          }}
        />
      </span>
      <span>{label}</span>
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      style={{
        background: "var(--panel-2)",
        border: "1px solid var(--line)",
        borderBottomWidth: 2,
        borderRadius: 4,
        padding: "0 5px",
        fontSize: "var(--fs-xs)",
        color: "var(--fg-muted)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </kbd>
  );
}

export function Divider({ vertical = false }: { vertical?: boolean }) {
  return (
    <span
      aria-hidden
      style={
        vertical
          ? { width: 1, alignSelf: "stretch", background: "var(--line)", flex: "0 0 auto" }
          : { height: 1, background: "var(--line)", display: "block" }
      }
    />
  );
}

/** A meter for proportions — merged/total, pass rate. Labelled, never bare. */
export function Meter({ value, max, tone = "accent" }: { value: number; max: number; tone?: Tone }) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <span
      role="meter"
      aria-valuenow={value}
      aria-valuemax={max}
      style={{
        display: "block",
        height: 4,
        background: "var(--panel-3)",
        borderRadius: "var(--r-full)",
        overflow: "hidden",
        minWidth: 40,
      }}
    >
      <span style={{ display: "block", width: `${pct}%`, height: "100%", background: TONE[tone].fg }} />
    </span>
  );
}
