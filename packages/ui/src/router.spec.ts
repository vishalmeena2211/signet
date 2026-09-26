// Routing is how every deep link works, so it is worth pinning: a filtered view
// or a selected run must survive being pasted into a message, and a malformed
// hash must land somewhere sensible rather than on a blank screen.

import { describe, expect, it } from "vitest";
import { href, navGroupOf, parseRoute, type Route } from "./router.js";

/** Every route should survive being written to a URL and read back. */
const ROUND_TRIP: Route[] = [
  { view: "overview" },
  { view: "work" },
  { view: "work", status: "needs-you" },
  { view: "work", status: "active", q: "cart" },
  { view: "feature", id: "096a877b-a07f-4107-8824-7374b81ce5e8" },
  { view: "feature", id: "096a877b-a07f-4107-8824-7374b81ce5e8", tab: "runs" },
  { view: "runs" },
  { view: "runs", outcome: "failed" },
  { view: "runs", outcome: "failed", selected: "61e6de45-58a0-4678-b97a-86d8564a6858" },
  { view: "constitution" },
  { view: "constitution", status: "CONFIRMED" },
  { view: "activity" },
  { view: "system" },
  { view: "new" },
];

describe("router", () => {
  it.each(ROUND_TRIP)("round-trips %j", (route) => {
    expect(parseRoute(href(route))).toEqual(route);
  });

  it("drops default filter values from the URL, so the plain screen has a clean link", () => {
    expect(href({ view: "work", status: "all" })).toBe("#/work");
    expect(href({ view: "runs", outcome: "all" })).toBe("#/runs");
    expect(href({ view: "constitution", status: "PROPOSED" })).toBe("#/constitution");
    expect(href({ view: "feature", id: "abc", tab: "increments" })).toBe("#/work/abc");
  });

  it("lands on the overview for anything it cannot parse, rather than rendering nothing", () => {
    for (const hash of ["", "#", "#/", "#/nope", "#/work/../etc", "#/?status=x"]) {
      expect(parseRoute(hash).view).toBe(hash.includes("work") ? "feature" : "overview");
    }
  });

  it("highlights Work while inside a feature or the new-feature form", () => {
    expect(navGroupOf({ view: "feature", id: "x" })).toBe("work");
    expect(navGroupOf({ view: "new" })).toBe("work");
    expect(navGroupOf({ view: "runs" })).toBe("runs");
  });

  it("encodes a search term that would otherwise break the query string", () => {
    const route: Route = { view: "work", q: "a&b=c d" };
    expect(parseRoute(href(route))).toEqual(route);
  });
});
