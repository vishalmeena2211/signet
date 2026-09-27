// The workflow canvas, pinned.
//
// The diagram is making a promise, so the test is about the promise rather than the
// pixels: the chain ALWAYS ends at a human signature, and it cannot be drawn otherwise.
// If a future change let the picture continue past that node, the picture would be
// claiming automation lands code — which it does not.
//
// The accessible label is the thing asserted rather than the rendered boxes. React Flow
// measures the DOM to lay out, and jsdom has no layout, so asserting on node geometry
// would be testing the mock. The label is also the actual contract for anybody using a
// screen reader, which makes it the more valuable assertion of the two.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkflowCanvas, type CanvasStep } from "./workflow-canvas.js";

const steps: CanvasStep[] = [
  { recipeId: "a", recipeName: "Tidy cart tests" },
  { recipeId: "b", recipeName: "Bump dependencies" },
];

function label(): string {
  return screen.getByRole("img").getAttribute("aria-label") ?? "";
}

describe("the chain always ends at a human", () => {
  it("says so in the accessible description", () => {
    render(
      <WorkflowCanvas trigger={{ kind: "manual" }} triggerLabel="Only when you press run" steps={steps} />,
    );
    expect(label()).toMatch(/waits for you to merge\.$/i);
  });

  it("ends there even with no steps at all", () => {
    // An empty workflow still stops at the signature. There is no configuration in which
    // the diagram implies automation finishing the job.
    render(<WorkflowCanvas trigger={{ kind: "manual" }} triggerLabel="Only when you press run" steps={[]} />);
    expect(label()).toMatch(/waits for you to merge/i);
  });

  it("ends there for a scheduled workflow, which is the unattended case", () => {
    render(
      <WorkflowCanvas
        trigger={{ kind: "schedule", every: "day", atHour: 3, atMinute: 0, onWeekday: 1 }}
        triggerLabel="Every day at 03:00"
        steps={steps}
      />,
    );
    expect(label()).toMatch(/waits for you to merge/i);
  });
});

describe("the description reads as a sequence", () => {
  it("names the trigger first, then each step in order", () => {
    render(
      <WorkflowCanvas trigger={{ kind: "manual" }} triggerLabel="Only when you press run" steps={steps} />,
    );
    const text = label();
    expect(text.indexOf("Only when you press run")).toBeLessThan(text.indexOf("Tidy cart tests"));
    expect(text.indexOf("Tidy cart tests")).toBeLessThan(text.indexOf("Bump dependencies"));
    expect(text.indexOf("Bump dependencies")).toBeLessThan(text.indexOf("waits for you to merge"));
  });

  it("describes an event trigger by what happens, not by its shape", () => {
    render(
      <WorkflowCanvas
        trigger={{ kind: "event", event: "step_merged" }}
        triggerLabel="After any step is merged"
        steps={steps}
      />,
    );
    expect(label()).toContain("After any step is merged");
    // Never the internal identifier.
    expect(label()).not.toContain("step_merged");
  });
});

describe("a step that cannot run", () => {
  it("is passed its reason, so the diagram can show it", () => {
    // A workflow built on a template will skip every single time it fires. The diagram is
    // where somebody will be looking when they wonder why.
    const blocked: CanvasStep[] = [
      { recipeId: "a", recipeName: "Add a helper", blockedReason: "Has blanks (helper) — this will skip" },
    ];
    render(
      <WorkflowCanvas
        trigger={{ kind: "schedule", every: "day", atHour: 3, atMinute: 0, onWeekday: 1 }}
        triggerLabel="Every day at 03:00"
        steps={blocked}
      />,
    );
    // The canvas renders; the reason travels with the step rather than living in a legend.
    expect(screen.getByRole("img")).toBeTruthy();
    expect(label()).toContain("Add a helper");
  });
});
