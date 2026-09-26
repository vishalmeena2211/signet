// How the console renders facts.
//
// Two rules run through all of it. First, relative time is for scanning and
// absolute time is for reasoning, so anything relative carries the exact
// timestamp in its tooltip. Second, an unknown value renders as an em dash with
// an explanation, never as zero — "we did not record this" and "this was zero"
// must not look the same on an operator screen.

import { useEffect, useState, type ReactNode } from "react";
import { Badge, Row, type Tone } from "./primitives.js";

/** A single clock for the whole app, so every relative time re-renders together. */
function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function formatAgo(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function RelativeTime({ iso, prefix }: { iso: string; prefix?: string }) {
  const now = useNow();
  return (
    <span title={new Date(iso).toLocaleString()} style={{ whiteSpace: "nowrap" }}>
      {prefix ? `${prefix} ` : ""}
      {formatAgo(iso, now)}
    </span>
  );
}

/** Elapsed time that keeps counting — for anything still running. */
export function LiveDuration({ since }: { since: string }) {
  const now = useNow(1000);
  return <span className="num">{formatDuration(now - new Date(since).getTime())}</span>;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}m ${rest}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function Duration({ ms }: { ms: number | null }) {
  return <span className="num">{formatDuration(ms)}</span>;
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function TokenCount({ n, title }: { n: number; title?: string }) {
  return (
    <span className="num" title={title ?? `${n.toLocaleString()} tokens`}>
      {formatCount(n)}
    </span>
  );
}

/**
 * Money, with "unknown" preserved. A null cost means no model in the sample had
 * a known price — reporting $0.00 there would understate spend, which is the one
 * direction a cost readout must never err in.
 */
export function Money({ usd }: { usd: number | null }) {
  if (usd === null) {
    return (
      <span title="No priced model in this sample — the cost is unknown, not zero." style={{ color: "var(--fg-subtle)" }}>
        —
      </span>
    );
  }
  // Four decimals below a dollar, two above. Individual runs cost cents, so
  // rounding $0.4357 to "$0.44" throws away the precision that makes per-run
  // costs comparable at all.
  return (
    <span className="num" title={`$${usd.toFixed(6)}`}>
      ${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}
    </span>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function Bytes({ n }: { n: number }) {
  return <span className="num">{formatBytes(n)}</span>;
}

/**
 * A UUID, shortened for reading and copyable in full. Operators correlate these
 * with logs constantly, so copying must not require selecting text precisely.
 */
export function Id({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {
            /* clipboard blocked (insecure context): the title still shows the full id */
          },
        );
      }}
      title={`${label ? `${label}: ` : ""}${value} — click to copy`}
      style={{
        fontFamily: "var(--mono)",
        fontSize: "var(--fs-xs)",
        color: copied ? "var(--ok)" : "var(--fg-subtle)",
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
      }}
    >
      {copied ? "copied" : value.slice(0, 8)}
    </button>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-sm)" }}>{children}</span>;
}

export function CodeBlock({ text, maxHeight = 320 }: { text: string; maxHeight?: number }) {
  return (
    <pre
      style={{
        background: "var(--bg)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-sm)",
        padding: "var(--s3)",
        maxHeight,
        overflow: "auto",
        fontFamily: "var(--mono)",
        fontSize: "var(--fs-sm)",
        lineHeight: 1.55,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {text}
    </pre>
  );
}

// ── shared status vocabularies ──
// Every screen shows increment state, run outcome and gate outcome, so their
// wording and tone are defined once. Divergent labels for the same state across
// screens is the fastest way to make a console feel untrustworthy.

export const INCREMENT_STATE: Record<string, { label: string; tone: Tone; help: string }> = {
  PLANNED: { label: "Planned", tone: "idle", help: "Decomposed but no context pack yet." },
  CONTEXT_READY: { label: "Ready", tone: "accent", help: "Waiting for signature 1 to start the run." },
  RUNNING: { label: "Running", tone: "run", help: "An agent is working in its own worktree." },
  VERIFYING: { label: "Verifying", tone: "run", help: "The gates are judging the result." },
  AWAITING_SIGNATURE: { label: "Awaiting merge", tone: "warn", help: "Every gate passed; waiting for signature 2." },
  MERGED: { label: "Merged", tone: "ok", help: "Landed on the base branch." },
  ESCALATED: { label: "Question", tone: "warn", help: "The agent stopped to ask rather than guess." },
  PARKED: { label: "Parked", tone: "idle", help: "Held by the quota window; resumes on its own." },
  FAILED: { label: "Failed", tone: "err", help: "Repair attempts were exhausted." },
};

export const RUN_OUTCOME: Record<string, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "run" },
  succeeded: { label: "Succeeded", tone: "ok" },
  failed: { label: "Failed", tone: "err" },
  aborted: { label: "Aborted", tone: "idle" },
  created: { label: "Queued", tone: "idle" },
};

export const GATE_OUTCOME: Record<string, Tone> = {
  pass: "ok",
  fail: "err",
  warn: "warn",
  skipped: "idle",
  running: "run",
};

export function StateBadge({ status }: { status: string }) {
  const s = INCREMENT_STATE[status];
  if (!s) return <Badge>{status}</Badge>;
  return (
    <span title={s.help}>
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}

export function GateBadge({ gate, outcome, count }: { gate: string; outcome: string; count?: number }) {
  return (
    <Badge tone={GATE_OUTCOME[outcome] ?? "neutral"} mono>
      {gate} {outcome}
      {count !== undefined && count > 0 ? ` ${count}` : ""}
    </Badge>
  );
}

/** Token in/out with the cache share, which is the number that explains cost. */
export function UsageLine({
  inputTokens,
  outputTokens,
  cachedInputTokens,
  costUsd,
}: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd: number | null;
}) {
  return (
    <Row gap="var(--s3)" style={{ color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
      <span>
        in <TokenCount n={inputTokens} />
        {cachedInputTokens !== undefined && cachedInputTokens > 0 && (
          <span style={{ color: "var(--fg-subtle)" }}>
            {" "}
            (<TokenCount n={cachedInputTokens} /> cached)
          </span>
        )}
      </span>
      <span>
        out <TokenCount n={outputTokens} />
      </span>
      <Money usd={costUsd} />
    </Row>
  );
}
