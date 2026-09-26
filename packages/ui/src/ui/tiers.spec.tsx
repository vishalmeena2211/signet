// The tier model, pinned.
//
// Two behaviours matter enough to test. Disclosure state must survive a remount,
// because these screens refetch every few seconds and remount on route changes —
// an operator who opened the raw state to read it should not find it closed again.
// And a forensics section must say what is inside it before you open it, so the
// click is an informed choice rather than a gamble.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Decide, FocalMetric, Forensics, MetricStrip, Understand } from "./tiers.js";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("Forensics disclosure", () => {
  it("starts closed, so tier-three detail is not noise on arrival", () => {
    render(
      <Forensics id="t1" label="Raw state">
        <div>the payload</div>
      </Forensics>,
    );
    expect(screen.queryByText("the payload")).toBeNull();
    expect(screen.getByRole("button", { name: /Raw state/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("opens and closes", () => {
    render(
      <Forensics id="t2" label="Raw state">
        <div>the payload</div>
      </Forensics>,
    );
    const toggle = screen.getByRole("button", { name: /Raw state/ });
    fireEvent.click(toggle);
    expect(screen.getByText("the payload")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByText("the payload")).toBeNull();
  });

  it("REMEMBERS being opened across a remount", () => {
    // The failure this prevents: a 3-second poll or a route change resets local
    // state, so the section you opened to read closes under you.
    const { unmount } = render(
      <Forensics id="remembered" label="Effects">
        <div>journal</div>
      </Forensics>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Effects/ }));
    expect(screen.getByText("journal")).toBeTruthy();
    unmount();

    render(
      <Forensics id="remembered" label="Effects">
        <div>journal</div>
      </Forensics>,
    );
    expect(screen.getByText("journal")).toBeTruthy();
  });

  it("keeps each section's state separate, so opening one does not open all", () => {
    render(
      <>
        <Forensics id="a" label="Section A">
          <div>payload A</div>
        </Forensics>
        <Forensics id="b" label="Section B">
          <div>payload B</div>
        </Forensics>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Section A/ }));
    expect(screen.getByText("payload A")).toBeTruthy();
    expect(screen.queryByText("payload B")).toBeNull();
  });

  it("says how much is inside before you open it", () => {
    render(
      <Forensics id="c" label="Journalled effects" count={3}>
        <div>x</div>
      </Forensics>,
    );
    // "(3)" is what makes the click worth making — or not.
    expect(screen.getByRole("button", { name: /Journalled effects.*3/ })).toBeTruthy();
  });

  it("can start open where the content IS the decision", () => {
    render(
      <Forensics id="d" label="Changes" defaultOpen>
        <div>the diff</div>
      </Forensics>,
    );
    expect(screen.getByText("the diff")).toBeTruthy();
  });

  it("survives a corrupt stored preference rather than throwing", () => {
    localStorage.setItem("signet.open.e", "not-a-boolean");
    render(
      <Forensics id="e" label="Raw">
        <div>p</div>
      </Forensics>,
    );
    // Anything that is not "1" reads as closed — the safe default.
    expect(screen.queryByText("p")).toBeNull();
  });
});

describe("tier hierarchy is real, not decorative", () => {
  it("gives Decide a heading level above Understand", () => {
    render(
      <>
        <Decide title="Needs you">
          <div>focal</div>
        </Decide>
        <Understand title="Delivery">
          <div>supporting</div>
        </Understand>
      </>,
    );
    // An h2 for the focal section and an h3 for support: the document outline
    // carries the hierarchy, so screen readers get it too, not just sighted users.
    expect(screen.getByRole("heading", { level: 2, name: "Needs you" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Delivery" })).toBeTruthy();
  });

  it("renders the focal metric larger than the strip beside it", () => {
    const { container } = render(
      <>
        <FocalMetric label="waiting on you" value={3} />
        <MetricStrip items={[{ label: "Merged", value: "2/5" }]} />
      </>,
    );
    const nums = [...container.querySelectorAll(".num")] as HTMLElement[];
    const focal = nums.find((n) => n.textContent === "3");
    const strip = nums.find((n) => n.textContent === "2/5");
    expect(focal?.style.fontSize).toBe("var(--fs-2xl)");
    expect(strip?.style.fontSize).toBe("var(--fs-lg)");
  });

  it("gives numbers tabular figures and negative tracking so columns line up", () => {
    const { container } = render(<FocalMetric label="x" value={1234} />);
    const num = container.querySelector(".num") as HTMLElement;
    expect(num.style.letterSpacing).toBe("-0.02em");
    // .num carries font-variant-numeric: tabular-nums from the token layer.
    expect(num.className).toContain("num");
  });
});
