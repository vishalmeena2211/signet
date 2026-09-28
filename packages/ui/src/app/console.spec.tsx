// The console's rules, pinned: the words a decision is written in, how a plan is
// reshaped, what a route means, and the seal that only lands on a full hold.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Decision } from "@signet/contracts";
import { decisionWords } from "./desk.js";
import { href, parseRoute } from "./router.js";
import { moveFile, moveStep, promisesOf, replaceFile, splitStep, type DraftStep } from "./plan.js";
import { patchRows } from "./patch.js";
import { checksSentence } from "./sheets.js";
import { triggerWords, evidenceText } from "./workshop.js";
import { rimText, SealButton, HOLD_MS } from "./seal.js";
import { headline } from "./watch.js";
import { Desk } from "./desk.js";

const base: Decision = {
  kind: "seal",
  featureId: "11111111-aaaa-4bbb-8ccc-000000000001" as Decision["featureId"],
  featureTitle: "Cluster markers at low zoom",
  incrementId: "11111111-aaaa-4bbb-8ccc-000000000002" as Decision["incrementId"],
  stepTitle: "Use it in the map layer",
  stepIndex: 2,
  stepCount: 3,
  since: new Date(Date.now() - 6 * 60_000).toISOString(),
  files: 2,
  added: 48,
  removed: 6,
  proven: 3,
  promises: 3,
  repairs: 1,
  spentUsd: 0.62,
  surface: ["src/layer.ts", "src/layer.test.ts"],
  text: null,
};

describe("a decision, in the Desk's words", () => {
  it("writes a seal as the frame does", () => {
    expect(decisionWords(base, false, null)).toEqual({
      what: "Seal “Use it in the map layer”",
      why: "Cluster markers at low zoom · every check passed, one repair along the way",
      meta: "2 files · +48 −6 · 3 of 3 promises proven · waiting 6 min",
      act: { label: "Review and seal", seal: true },
    });
  });

  it("writes initials and questions as verbs", () => {
    expect(decisionWords({ ...base, kind: "initial", spentUsd: null }, false, null).what).toBe("Initial the plan for “Use it in the map layer”");
    expect(decisionWords({ ...base, kind: "initial", spentUsd: null }, false, null).why).toContain("step 2 of 3 · nothing spent yet");
    expect(decisionWords({ ...base, kind: "question", text: "Retry or skip?" }, false, null).what).toBe("Signet asked: Retry or skip?");
  });

  it("says sealing needs no quota while held", () => {
    expect(decisionWords(base, true, null).meta).toContain("sealing lands it now, no quota needed");
  });
});

describe("routes", () => {
  it("round-trips every place and sheet", () => {
    const routes = [
      { view: "desk" },
      { view: "ask" },
      { view: "thread", featureId: "f1", sheet: { kind: "seal", step: "s1", tab: "change" }, from: "desk" },
      { view: "watch", featureId: "f1", step: "s1" },
      { view: "flow", tab: "ledger", open: "s1" },
      { view: "workshop", tab: "health" },
      { view: "welcome", repoId: "/Users/me/code/cartographer" },
    ] as const;
    for (const r of routes) expect(parseRoute(href(r))).toMatchObject(r);
  });

  it("lands anything unknown on the Desk", () => {
    expect(parseRoute("#/nowhere/at/all")).toEqual({ view: "desk" });
  });
});

describe("reshaping a plan by hand", () => {
  const step = (title: string, surface: string[], promises = ["a", "b", "c"]): DraftStep => ({ title, rationale: "", surface, promises, doubts: [], picks: [] });

  it("moves a file between fences", () => {
    expect(moveFile([step("a", ["x.ts", "y.ts"]), step("b", ["z.ts"])], 0, 1, "y.ts").map((s) => s.surface)).toEqual([["x.ts"], ["z.ts", "y.ts"]]);
  });

  it("cuts a step between promises and never at an end", () => {
    const out = splitStep([step("a", ["x.ts"])], 0, 1);
    expect(out.map((s) => [s.title, s.promises])).toEqual([
      ["a", ["a"]],
      ["a (continued)", ["b", "c"]],
    ]);
    expect(splitStep([step("a", ["x.ts"])], 0, 0)).toHaveLength(1);
  });

  it("reorders, and fixes a fence in one click", () => {
    expect(moveStep([step("a", []), step("b", [])], 1, 0).map((s) => s.title)).toEqual(["b", "a"]);
    expect(replaceFile([step("a", ["src/clustering/**", "t.ts"])], "src/clustering/**", "src/cluster.ts")[0]?.surface).toEqual(["src/cluster.ts", "t.ts"]);
  });

  it("reads promises one per bullet", () => {
    expect(promisesOf("- One point stays one point\n- **An empty list** returns empty")).toEqual(["One point stays one point", "An empty list returns empty"]);
  });
});

describe("what the sheets say", () => {
  it("reads the checks out as a sentence", () => {
    expect(
      checksSentence([
        { gate: "typecheck", outcome: "pass" },
        { gate: "lint", outcome: "pass" },
        { gate: "tests", outcome: "pass" },
        { gate: "conformance", outcome: "skipped" },
        { gate: "rules", outcome: "pass" },
      ]),
    ).toBe("Types · Lint · Tests passed. Design has nothing to compare against. Conventions passed.");
  });

  it("numbers the lines a note can sit on", () => {
    const rows = patchRows(["+++ b/src/layer.ts", "@@ -44,2 +44,3 @@", " a", "-b", "+c", "+d"].join("\n"));
    expect(rows.filter((r) => r.line !== null).map((r) => [r.kind, r.line])).toEqual([
      ["ctx", 44],
      ["add", 45],
      ["add", 46],
    ]);
  });

  it("stamps the date, time and commit round the seal", () => {
    expect(rimText(new Date(2026, 8, 28, 15, 14), "7c41e0a9")).toBe("SEALED · 28 SEP 2026 · 3:14 PM · 7C41E0A · ");
  });
});

describe("routines and conventions, in words", () => {
  it("writes a trigger as the start of a sentence", () => {
    expect(triggerWords({ kind: "schedule", every: "day", atHour: 3, atMinute: 0, onWeekday: 1 })).toEqual(["Every", "night at 3:00"]);
    expect(triggerWords({ kind: "event", event: "step_merged" })).toEqual(["When", "a step lands"]);
    expect(triggerWords({ kind: "manual" })).toEqual(["When", "I say so"]);
  });

  it("counts a convention's evidence and exceptions", () => {
    const card = { id: "r", statement: "s", kind: "token", evidence: [{ ref: "a", kind: "usage" }, { ref: "b", kind: "usage" }], confidence: 0.9, trend: "stable", status: "PROPOSED", fpCount: 0, exceptions: [{ path: "x", reason: "y", approvedBy: "z" }] } as const;
    expect(evidenceText(card as never)).toBe("2 uses · 1 exception");
  });
});

describe("watching it work", () => {
  it("leads with what it is doing now, in its own words", () => {
    expect(headline([{ content: "Make it pass", status: "in_progress", activeForm: "Making the new test pass" }], [])).toBe("Making the new test pass");
    expect(headline([], [{ at: new Date().toISOString(), kind: "edit", path: "src/layer.ts", phase: "implement" }])).toBe("Editing src/layer.ts");
  });
});

describe("the seal lands only on a full hold", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("does nothing when let go early, and seals once when held long enough", () => {
    const onSeal = vi.fn();
    render(<SealButton initials="VM" onSeal={onSeal} />);
    const seal = screen.getByRole("button", { name: /hold to seal/i });

    fireEvent.pointerDown(seal);
    act(() => void vi.advanceTimersByTime(HOLD_MS / 2));
    fireEvent.pointerUp(seal);
    expect(onSeal).not.toHaveBeenCalled();

    fireEvent.pointerDown(seal);
    act(() => void vi.advanceTimersByTime(HOLD_MS + 100));
    expect(onSeal).toHaveBeenCalledTimes(1);
  });

  it("cannot be pressed while it is off", () => {
    const onSeal = vi.fn();
    render(<SealButton initials="VM" off onSeal={onSeal} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /hold to seal/i }));
    act(() => void vi.advanceTimersByTime(HOLD_MS * 2));
    expect(onSeal).not.toHaveBeenCalled();
  });
});

describe("the Desk", () => {
  function wrap(children: ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  const desk = (decisions: Decision[]) => ({
    identity: { signature: "V. Meena", initials: "VM" },
    repoLabel: "cartographer",
    status: { building: 2, spentTodayUsd: 1.84, held: null },
    flow: { asked: 1, toInitial: 1, building: 2, checking: 1, toSeal: 1, landedToday: 12 },
    decisions,
    lastLandedAt: null,
  });
  let body: unknown;
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists what waits on you, with the two lanes that are yours lit", async () => {
    body = desk([base]);
    render(wrap(<Desk />));
    expect(await screen.findByText("Seal “Use it in the map layer”")).toBeTruthy();
    expect(screen.getByText("Review and seal")).toBeTruthy();
    expect(screen.getByText("To seal").parentElement?.className).toContain("yours");
    expect(screen.getByText("Building").parentElement?.className).not.toContain("yours");
  });

  it("says nothing needs you when nothing does", async () => {
    body = desk([]);
    render(wrap(<Desk />));
    expect(await screen.findByText("Nothing needs you.")).toBeTruthy();
  });
});
