// A feature's steps as a strip of segments.
//
// The board used to say "1/3 done" with a progress bar. That sentence is identical for
// three situations that want three different reactions from you:
//
//   · one step running, two queued          — nothing to do, come back later
//   · one step FAILED, two queued           — it is stuck and will stay stuck
//   · one step waiting on your signature    — it is blocked ON YOU
//
// A count cannot tell them apart and a progress bar makes it worse, because a bar treats
// "failed" and "not started" as the same absence. One segment per step, coloured by state,
// separates them at a glance — and the one that needs you is the one that is amber.
//
// Deliberately not a chart library or a tooltip. It is six divs, it degrades to a
// sentence for a screen reader, and the whole thing fits in a table cell.

import type { ReactNode } from "react";

/** Every increment status, mapped to how the strip paints it. */
const PAINT: Record<string, { colour: string; word: string }> = {
  MERGED: { colour: "var(--ok)", word: "merged" },
  AWAITING_SIGNATURE: { colour: "var(--warn)", word: "waiting for you to merge" },
  CONTEXT_READY: { colour: "var(--accent)", word: "waiting for you to approve" },
  RUNNING: { colour: "var(--accent)", word: "running" },
  VERIFYING: { colour: "var(--accent)", word: "checking" },
  ESCALATED: { colour: "var(--warn)", word: "asking you a question" },
  PARKED: { colour: "var(--idle)", word: "waiting for quota" },
  FAILED: { colour: "var(--err)", word: "failed" },
  PLANNED: { colour: "var(--line-strong)", word: "not started" },
};

/** States that are the human's move. Drawn taller, because that is the whole point. */
const YOURS = new Set(["AWAITING_SIGNATURE", "CONTEXT_READY", "ESCALATED"]);

export interface StepStripProps {
  states: readonly string[];
  /** Taller and more legible on a detail page than in a table row. */
  size?: "row" | "page";
}

export function StepStrip({ states, size = "row" }: StepStripProps): ReactNode {
  if (states.length === 0) {
    return <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)" }}>no steps</span>;
  }

  const base = size === "page" ? 10 : 6;
  // A summary sentence rather than a per-segment tooltip: hover text is invisible to
  // anyone not using a mouse, and this is load-bearing information.
  const counts = new Map<string, number>();
  for (const st of states) {
    const word = PAINT[st]?.word ?? st.toLowerCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const spoken = `${states.length} step${states.length === 1 ? "" : "s"}: ${[...counts]
    .map(([word, n]) => `${n} ${word}`)
    .join(", ")}.`;

  return (
    <div
      role="img"
      aria-label={spoken}
      title={spoken}
      style={{ display: "flex", gap: 2, alignItems: "flex-end", minWidth: 0 }}
    >
      {states.map((st, i) => {
        const paint = PAINT[st] ?? { colour: "var(--line-strong)", word: st };
        const mine = YOURS.has(st);
        return (
          <span
            key={i}
            aria-hidden="true"
            style={{
              flex: "1 1 0",
              minWidth: 4,
              maxWidth: 40,
              // The segments that need you stand proud of the rest, so a strip with one
              // amber segment reads as "something here" from across the room.
              height: mine ? base + 4 : base,
              background: paint.colour,
              borderRadius: 1,
              // Not-started segments are outlines, so absence looks like absence rather
              // than like a fourth colour.
              ...(st === "PLANNED"
                ? { background: "transparent", border: `1px solid ${paint.colour}` }
                : {}),
            }}
          />
        );
      })}
    </div>
  );
}
