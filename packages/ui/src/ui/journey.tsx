// Where a step is in its journey, drawn rather than named.
//
// The card used to say "Working" in a badge and leave it there. That is accurate
// and almost useless: it tells you the current state but not the shape of the
// thing — how far along it is, what already happened, what comes next, and which
// of the two signatures is the one still owed. People asked "so what happens now?"
// while looking at a screen that technically already answered it.
//
// So the six stages are always all visible, and the current one is marked. A stage
// you have passed reads differently from one you have not reached, and the two
// stages that are YOURS are marked as yours even before they are reachable — the
// point of the product is that a feature sits between two human signatures, and
// the UI should make that obvious without being read a paragraph first.
//
// Detours (asking you a question, waiting for quota, giving up) are not separate
// stages. They are an interruption AT a stage, so they are drawn on the stage they
// interrupted rather than as a seventh box, which would imply a linear path that
// passes through them.

import type { CSSProperties, ReactNode } from "react";

/** What the rail shows for one stage. */
type StageState =
  /** Behind us. */
  | "done"
  /** Happening now, by itself. */
  | "active"
  /** Happening now, and waiting for the person reading this. */
  | "yours"
  /** Stopped here — escalated, parked, or failed. */
  | "stopped"
  /** Not reached. */
  | "todo";

interface Stage {
  key: string;
  label: string;
  /** Whose move this is. Signature stages stay marked even when not yet reached. */
  mine: boolean;
}

const STAGES: Stage[] = [
  { key: "brief", label: "What you want", mine: false },
  { key: "approve", label: "You approve", mine: true },
  { key: "write", label: "Writes code", mine: false },
  { key: "check", label: "Checks", mine: false },
  { key: "merge", label: "You merge", mine: true },
  { key: "merged", label: "Merged", mine: false },
];

/**
 * How far along each status is. The index is the stage the status is AT; earlier
 * stages are done, later ones are not reached.
 *
 * PLANNED and CONTEXT_READY are both at the approve stage: a step is created
 * already at CONTEXT_READY, so "waiting for you to approve" is the first thing a
 * new step is, not something it becomes.
 */
export const JOURNEY_STAGE_BY_STATUS: Record<string, { index: number; state: StageState }> = {
  PLANNED: { index: 1, state: "todo" },
  CONTEXT_READY: { index: 1, state: "yours" },
  RUNNING: { index: 2, state: "active" },
  VERIFYING: { index: 3, state: "active" },
  AWAITING_SIGNATURE: { index: 4, state: "yours" },
  MERGED: { index: 5, state: "done" },
  ESCALATED: { index: 2, state: "stopped" },
  PARKED: { index: 2, state: "stopped" },
  FAILED: { index: 2, state: "stopped" },
};

/** What interrupted us, in the words the rail uses under the marked stage. */
const DETOUR: Record<string, string> = {
  ESCALATED: "asking you a question",
  PARKED: "waiting for quota",
  FAILED: "stopped here",
};

function stageStates(status: string): StageState[] {
  const at = JOURNEY_STAGE_BY_STATUS[status];
  // An unknown status must not silently render as "nothing has happened yet".
  if (!at) return STAGES.map(() => "todo");
  return STAGES.map((stage, i) => {
    if (i < at.index) return "done";
    if (i > at.index) return "todo";
    // The final stage is only ever reached by finishing it.
    if (stage.key === "merged") return at.state === "done" ? "done" : "todo";
    return at.state;
  });
}

const DOT: Record<StageState, CSSProperties> = {
  done: { background: "var(--ok)", borderColor: "var(--ok)" },
  active: { background: "var(--accent)", borderColor: "var(--accent)" },
  yours: { background: "var(--warn)", borderColor: "var(--warn)" },
  stopped: { background: "var(--err)", borderColor: "var(--err)" },
  todo: { background: "transparent", borderColor: "var(--line-strong)" },
};

const LABEL: Record<StageState, string> = {
  done: "var(--fg-muted)",
  active: "var(--accent)",
  yours: "var(--warn)",
  stopped: "var(--err)",
  todo: "var(--fg-subtle)",
};

export interface JourneyProps {
  status: string;
  /** Shown beside the checks stage when a repair round is in progress. */
  repairAttempt?: number;
}

/**
 * The rail. Deliberately not interactive: it answers "where am I" and nothing
 * else, so there is no state in which clicking it is the obvious next thing.
 */
export function Journey({ status, repairAttempt = 0 }: JourneyProps): ReactNode {
  const states = stageStates(status);
  const detour = DETOUR[status];
  const currentIndex = JOURNEY_STAGE_BY_STATUS[status]?.index ?? -1;

  return (
    <div
      // A list, because that is what it is: an ordered sequence of stages with
      // one of them current. Screen readers get the sequence and the position.
      role="list"
      aria-label="Progress through this step"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${STAGES.length}, 1fr)`,
        gap: 0,
        alignItems: "start",
      }}
    >
      {STAGES.map((stage, i) => {
        const state = states[i] as StageState;
        const isCurrent = i === currentIndex && state !== "todo" && state !== "done";
        const showDetour = Boolean(detour) && i === currentIndex;
        const repairHere = stage.key === "check" && repairAttempt > 0 && states[i] !== "todo";

        return (
          <div
            key={stage.key}
            role="listitem"
            aria-current={isCurrent ? "step" : undefined}
            style={{ display: "flex", flexDirection: "column", gap: "var(--s1)", minWidth: 0 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
              {/* Connector before the dot, except on the first stage. A line that
                  is behind us is solid; one ahead of us is not, so the rail reads
                  as a path travelled rather than a row of equal pills. */}
              <span
                aria-hidden="true"
                style={{
                  flex: 1,
                  height: 2,
                  background: i === 0 ? "transparent" : states[i - 1] === "done" ? "var(--ok)" : "var(--line)",
                }}
              />
              <span
                aria-hidden="true"
                style={{
                  width: state === "todo" ? 8 : 10,
                  height: state === "todo" ? 8 : 10,
                  borderRadius: "50%",
                  border: "2px solid",
                  boxSizing: "border-box",
                  flex: "0 0 auto",
                  ...DOT[state],
                }}
              />
              <span
                aria-hidden="true"
                style={{
                  flex: 1,
                  height: 2,
                  background: i === STAGES.length - 1 ? "transparent" : state === "done" ? "var(--ok)" : "var(--line)",
                }}
              />
            </div>

            <div style={{ textAlign: "center", padding: "0 2px" }}>
              <div
                style={{
                  fontSize: "var(--fs-xs)",
                  color: LABEL[state],
                  fontWeight: isCurrent ? 600 : 400,
                  lineHeight: "var(--lh-tight)",
                }}
              >
                {stage.label}
              </div>
              {/* The two signature stages say so, so that "this one is on you" is
                  legible before you have to learn the colour code. */}
              {stage.mine && state === "todo" && (
                <div style={{ fontSize: "var(--fs-xs)", color: "var(--fg-subtle)", lineHeight: "var(--lh-tight)" }}>
                  yours
                </div>
              )}
              {showDetour && (
                <div style={{ fontSize: "var(--fs-xs)", color: "var(--err)", lineHeight: "var(--lh-tight)" }}>
                  {detour}
                </div>
              )}
              {repairHere && !showDetour && (
                <div style={{ fontSize: "var(--fs-xs)", color: "var(--warn)", lineHeight: "var(--lh-tight)" }}>
                  fixing, round {repairAttempt + 1}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
