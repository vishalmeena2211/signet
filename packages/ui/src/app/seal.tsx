// The seal: the product's one physical gesture.
//
// A signet is a seal ring. The irreversible decision — landing work on main — is made by
// pressing and holding a seal: the ring fills while you hold, and letting go early does
// nothing. Afterwards the impression is stamped on the page with the date, time and
// commit running round its rim.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

/** How long a press has to last. Long enough to be deliberate, short enough to be quick. */
export const HOLD_MS = 1000;

/**
 * The impression: a scalloped disc, initials in the middle, the rim text running round.
 * `trust` draws it hollow and dashed — a seal on trust is permanently distinguishable.
 */
export function SealMark({
  size = 120,
  initials,
  rim = "",
  trust = false,
}: {
  size?: number;
  initials: string;
  rim?: string;
  trust?: boolean;
}): ReactNode {
  const id = `rim-${useId().replace(/:/g, "")}`;
  const bumps = 44;
  const points: string[] = [];
  for (let i = 0; i < bumps * 2; i++) {
    const a = (Math.PI * i) / bumps;
    const r = i % 2 ? 47.2 : 50;
    points.push(`${i ? "L" : "M"}${(50 + r * Math.cos(a)).toFixed(2)} ${(50 + r * Math.sin(a)).toFixed(2)}`);
  }
  return (
    <svg className={`imp ${trust ? "trust" : ""}`} width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={trust ? "Sealed on trust" : "Sealed"}>
      <path className="edge" d={`${points.join("")}Z`} />
      <circle className="inner" cx="50" cy="50" r="41" />
      <circle className="inner" cx="50" cy="50" r="27" />
      {rim && (
        <>
          <path id={id} className="rimpath" d="M50 16 a34 34 0 1 1 -0.01 0" />
          <text className="rim">
            <textPath href={`#${id}`}>{rim}</textPath>
          </text>
        </>
      )}
      <text className="ini" x="50" y={rim ? 58 : 60} textAnchor="middle" fontSize={rim ? 22 : 34}>
        {initials}
      </text>
    </svg>
  );
}

/** "SEALED · 28 SEP 2026 · 3:14 PM · 7C41E0A · " */
export function rimText(at: Date, sha: string | null): string {
  const month = at.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
  const date = `${at.getDate()} ${month} ${at.getFullYear()}`;
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toUpperCase();
  return `SEALED · ${date} · ${time}${sha ? ` · ${sha.slice(0, 7).toUpperCase()}` : ""} · `;
}

/**
 * The seal you press and hold. Pointer or Enter; the ring shows progress; completing
 * the hold calls onSeal once. Disabled (`off`) it is grey and does nothing.
 */
export function SealButton({
  initials,
  off = false,
  onSeal,
  label = "Press and hold to seal",
}: {
  initials: string;
  off?: boolean;
  onSeal: () => void;
  label?: string;
}): ReactNode {
  const [pct, setPct] = useState(0);
  const start = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const done = useRef(false);

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    start.current = null;
    if (!done.current) setPct(0);
  }, []);

  const tick = useCallback(
    (now: number) => {
      if (start.current === null) start.current = now;
      const p = Math.min(1, (now - start.current) / HOLD_MS);
      setPct(p * 100);
      if (p >= 1) {
        done.current = true;
        frame.current = null;
        onSeal();
        return;
      }
      frame.current = requestAnimationFrame(tick);
    },
    [onSeal],
  );

  const begin = useCallback(() => {
    if (off || done.current || frame.current !== null) return;
    frame.current = requestAnimationFrame(tick);
  }, [off, tick]);

  useEffect(() => stop, [stop]);
  // A seal that has been used can be pressed again only if the page offers it again.
  useEffect(() => {
    if (off) {
      done.current = false;
      setPct(0);
    }
  }, [off]);

  const C = 2 * Math.PI * 42;
  return (
    <button
      type="button"
      className={`sealbtn ${off ? "off" : ""}`}
      aria-label={label}
      aria-disabled={off}
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") stop();
      }}
      style={{ border: 0, background: "transparent", padding: 0, cursor: off ? "not-allowed" : "pointer" }}
    >
      <svg width="88" height="88" viewBox="0 0 88 88">
        <circle className="track" cx="44" cy="44" r="42" />
        <circle className="fillr" cx="44" cy="44" r="42" strokeDasharray={C.toFixed(1)} strokeDashoffset={(C * (1 - pct / 100)).toFixed(1)} />
      </svg>
      <span className="face">{initials}</span>
    </button>
  );
}
