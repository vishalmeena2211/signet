// The step strip, pinned.
//
// It exists for one reason: a count cannot tell apart three situations that want three
// different reactions from you. "1/3 done" is the same sentence for a feature that is
// quietly working, one that is stuck forever, and one that is blocked on your signature.
//
// So the tests are about that distinction surviving, and about it surviving for somebody
// who cannot see the colours — which is why the assertions are on the spoken description
// rather than on fills. A strip whose meaning lives only in hue is a strip that means
// nothing to a screen reader and nothing in a screenshot printed in black and white.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StepStrip } from "./step-strip.js";

function spoken(): string {
  return screen.getByRole("img").getAttribute("aria-label") ?? "";
}

describe("three situations a count cannot tell apart", () => {
  it("working: one running, two not started", () => {
    render(<StepStrip states={["RUNNING", "PLANNED", "PLANNED"]} />);
    expect(spoken()).toContain("1 running");
    expect(spoken()).toContain("2 not started");
  });

  it("stuck: one failed, two not started", () => {
    render(<StepStrip states={["FAILED", "PLANNED", "PLANNED"]} />);
    expect(spoken()).toContain("1 failed");
  });

  it("blocked on you: one waiting for your signature", () => {
    render(<StepStrip states={["AWAITING_SIGNATURE", "PLANNED", "PLANNED"]} />);
    expect(spoken()).toContain("waiting for you to merge");
  });

  it("all three read differently, which is the entire point", () => {
    // The same "1/3 done" for all three previously. If these ever collapse to the same
    // description, the component has stopped doing its job.
    const descriptions = new Set<string>();
    for (const first of ["RUNNING", "FAILED", "AWAITING_SIGNATURE"]) {
      const { unmount } = render(<StepStrip states={[first, "PLANNED", "PLANNED"]} />);
      descriptions.add(spoken());
      unmount();
    }
    expect(descriptions.size).toBe(3);
  });
});

describe("it says which move is yours", () => {
  it("uses your words for the states that need you", () => {
    render(<StepStrip states={["CONTEXT_READY"]} />);
    expect(spoken()).toContain("waiting for you to approve");
  });

  it("describes a question as asking you, not as an error", () => {
    // ESCALATED is the system behaving correctly — it stopped rather than guessing.
    render(<StepStrip states={["ESCALATED"]} />);
    expect(spoken()).toContain("asking you a question");
    expect(spoken()).not.toContain("error");
  });

  it("counts repeats rather than listing them", () => {
    render(<StepStrip states={["MERGED", "MERGED", "MERGED"]} />);
    expect(spoken()).toContain("3 merged");
  });
});

describe("edges", () => {
  it("says so when a feature has no steps, instead of drawing nothing", () => {
    render(<StepStrip states={[]} />);
    expect(screen.getByText("no steps")).toBeTruthy();
  });

  it("does not crash on a status it has never seen", () => {
    // A new increment status should degrade to its own name, not blank the row.
    render(<StepStrip states={["SOMETHING_NEW"]} />);
    expect(spoken()).toContain("something_new");
  });

  it("renders one segment per step", () => {
    const { container } = render(<StepStrip states={["MERGED", "RUNNING", "PLANNED", "FAILED"]} />);
    // The segments are decorative; the description carries the meaning. Counting them
    // guards against a layout change silently dropping steps off the end.
    expect(container.querySelectorAll("span[aria-hidden='true']")).toHaveLength(4);
  });
});
