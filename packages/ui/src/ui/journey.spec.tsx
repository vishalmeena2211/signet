// The journey rail, pinned.
//
// This component's only job is to answer "where is this step, and is it on me".
// Getting the stage mapping subtly wrong is both easy and invisible — a rail that
// confidently points at the wrong stage looks exactly as trustworthy as one that
// points at the right one. So the mapping is tested per state rather than eyeballed.
//
// Every status in the increment state machine gets a case here. A new status added
// to the domain without a mapping would otherwise render as "nothing has happened
// yet", which is the most misleading thing this component could possibly say.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ALLOWED_INCREMENT_TRANSITIONS } from "@signet/contracts";
import { Journey, JOURNEY_STAGE_BY_STATUS } from "./journey.js";

/** The stage marked `aria-current="step"`, or null when none is. */
function currentStage(): string | null {
  const items = screen.getAllByRole("listitem");
  const current = items.find((el) => el.getAttribute("aria-current") === "step");
  return current?.textContent ?? null;
}

describe("which stage the rail points at", () => {
  it("points at your approval for a step that was just created", () => {
    // Steps are created already at CONTEXT_READY, so this is the state a brand new
    // step is in — the very first thing the rail will ever be asked to draw.
    render(<Journey status="CONTEXT_READY" />);
    expect(currentStage()).toContain("You approve");
  });

  it("points at writing while the agent works", () => {
    render(<Journey status="RUNNING" />);
    expect(currentStage()).toContain("Writes code");
  });

  it("points at the checks while they run", () => {
    render(<Journey status="VERIFYING" />);
    expect(currentStage()).toContain("Checks");
  });

  it("points at your merge once everything passed", () => {
    render(<Journey status="AWAITING_SIGNATURE" />);
    expect(currentStage()).toContain("You merge");
  });

  it("marks nothing as current once merged, because nothing is outstanding", () => {
    render(<Journey status="MERGED" />);
    expect(currentStage()).toBeNull();
  });
});

describe("the two signatures announce themselves", () => {
  it("says a signature stage is yours before you can reach it", () => {
    // The product's whole claim is that a feature sits between two human
    // signatures. That has to be legible on arrival, not only once the colour
    // code has been learned.
    render(<Journey status="RUNNING" />);
    // Writing is in progress, so the merge signature is still out of reach.
    const merge = screen.getAllByRole("listitem").find((el) => el.textContent?.includes("You merge"));
    expect(merge?.textContent).toContain("yours");
  });

  it("stops saying 'yours' once that signature is the current stage", () => {
    render(<Journey status="AWAITING_SIGNATURE" />);
    const merge = screen.getAllByRole("listitem").find((el) => el.textContent?.includes("You merge"));
    // It is current now — labelling it "yours" as well would be noise.
    expect(merge?.textContent).not.toContain("yours");
  });
});

describe("detours are drawn on the stage they interrupted", () => {
  it("says it is asking you a question", () => {
    render(<Journey status="ESCALATED" />);
    expect(screen.getByText("asking you a question")).toBeTruthy();
  });

  it("says it is waiting for quota", () => {
    render(<Journey status="PARKED" />);
    expect(screen.getByText("waiting for quota")).toBeTruthy();
  });

  it("says where it stopped when it failed", () => {
    render(<Journey status="FAILED" />);
    expect(screen.getByText("stopped here")).toBeTruthy();
  });

  it("does not invent a seventh stage for a detour", () => {
    // A detour is a state AT a stage. Adding a box would imply the happy path runs
    // through "asking you a question", which it does not.
    render(<Journey status="ESCALATED" />);
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
  });
});

describe("repair rounds", () => {
  it("says which repair round the checks are on", () => {
    render(<Journey status="VERIFYING" repairAttempt={1} />);
    expect(screen.getByText("fixing, round 2")).toBeTruthy();
  });

  it("says nothing about repairs on a first clean pass", () => {
    render(<Journey status="VERIFYING" repairAttempt={0} />);
    expect(screen.queryByText(/fixing, round/)).toBeNull();
  });

  it("lets a detour win over a repair note, because stopping is the bigger news", () => {
    render(<Journey status="FAILED" repairAttempt={2} />);
    expect(screen.getByText("stopped here")).toBeTruthy();
    expect(screen.queryByText(/fixing, round/)).toBeNull();
  });
});

describe("a status the rail does not know", () => {
  it("claims no progress rather than guessing", () => {
    // The failure mode being prevented: a new domain status silently rendering as
    // a fresh, untouched step — which reads as authoritative and is wrong.
    render(<Journey status="SOMETHING_NEW" />);
    expect(currentStage()).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
  });

  it("still draws the whole journey, so the screen does not lose the shape", () => {
    render(<Journey status="SOMETHING_NEW" />);
    for (const label of ["What you want", "You approve", "Writes code", "Checks", "You merge", "Merged"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});

describe("the rail cannot drift from the domain", () => {
  it("has a stage for every status the state machine can be in", () => {
    // The unknown-status fallback above keeps a gap from crashing, but a silent
    // fallback is not a plan — a status the domain can legally reach must be drawn
    // deliberately. This fails the moment someone adds a status without deciding
    // where on the journey it belongs, which is the point.
    const domain = Object.keys(ALLOWED_INCREMENT_TRANSITIONS).sort();
    const drawn = Object.keys(JOURNEY_STAGE_BY_STATUS).sort();
    expect(drawn).toEqual(domain);
  });
});
