// How facts are rendered, pinned.
//
// The load-bearing case is Money: a null cost means no model in the sample had a
// known price, and rendering that as $0.00 would understate spend — the one
// direction a cost readout must never err in. There is a test for it because it
// is exactly the kind of thing a later "simplification" would break.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { formatAgo, formatBytes, formatCount, formatDuration, Money, StateBadge, GateBadge } from "./format.js";

describe("formatDuration", () => {
  it("scales the unit to the magnitude", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(62_218)).toBe("1m 2s");
    expect(formatDuration(3_700_000)).toBe("1h 1m");
  });

  it("renders an unknown duration as an em dash, not as zero", () => {
    expect(formatDuration(null)).toBe("—");
  });
});

describe("formatAgo", () => {
  const now = new Date("2026-09-26T12:00:00.000Z").getTime();
  const ago = (ms: number) => formatAgo(new Date(now - ms).toISOString(), now);

  it("reads as a human would say it", () => {
    expect(ago(3_000)).toBe("just now");
    expect(ago(45_000)).toBe("45s ago");
    expect(ago(5 * 60_000)).toBe("5m ago");
    expect(ago(3 * 3600_000)).toBe("3h ago");
    expect(ago(2 * 24 * 3600_000)).toBe("2d ago");
  });

  it("does not say a future timestamp was long ago", () => {
    // Clock skew between the browser and the server is normal; the readout
    // should degrade to "just now" rather than printing a negative age.
    expect(formatAgo(new Date(now + 5000).toISOString(), now)).toBe("just now");
  });
});

describe("formatCount", () => {
  it("abbreviates large token counts but keeps small ones exact", () => {
    expect(formatCount(42)).toBe("42");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(2458)).toBe("2.5k");
    expect(formatCount(48_000)).toBe("48k");
    expect(formatCount(1_500_000)).toBe("1.5M");
  });
});

describe("formatBytes", () => {
  it("uses the unit that keeps the number readable", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 kB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
  });
});

describe("Money", () => {
  it("shows four decimals for sub-cent amounts, two above", () => {
    const { container } = render(<Money usd={0.4357} />);
    expect(container.textContent).toBe("$0.4357");
    const big = render(<Money usd={12.5} />);
    expect(big.container.textContent).toBe("$12.50");
  });

  it("NEVER renders an unknown cost as zero", () => {
    const { container } = render(<Money usd={null} />);
    expect(container.textContent).toBe("—");
    expect(container.textContent).not.toContain("0");
    // The explanation lives in the tooltip so the dash is not a mystery.
    expect(container.querySelector("span")?.getAttribute("title")).toMatch(/unknown, not zero/i);
  });
});

describe("status vocabularies", () => {
  it("translates step states into words with the reason attached", () => {
    render(<StateBadge status="AWAITING_SIGNATURE" />);
    expect(screen.getByText("Ready to merge")).toBeTruthy();
    // The help text is what makes a state self-explanatory to a new operator.
    expect(screen.getByTitle(/waiting for you to merge it/i)).toBeTruthy();
  });

  it("falls back to the raw status rather than hiding an unknown state", () => {
    render(<StateBadge status="SOMETHING_NEW" />);
    expect(screen.getByText("SOMETHING_NEW")).toBeTruthy();
  });

  it("shows a gate's finding count only when it has findings and passed", () => {
    const { container: withCount } = render(<GateBadge gate="rules" outcome="warn" count={3} />);
    expect(withCount.textContent).toContain("your rules warn 3");
    const { container: noCount } = render(<GateBadge gate="tests" outcome="pass" count={0} />);
    expect(noCount.textContent).toBe("tests pass");
  });
});
