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
import { routineGraph } from "./routine-canvas.js";
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
        { gate: "typecheck", outcome: "pass", note: null },
        { gate: "lint", outcome: "pass", note: null },
        { gate: "tests", outcome: "pass", note: null },
        { gate: "conformance", outcome: "skipped", note: null },
        { gate: "rules", outcome: "pass", note: null },
      ]),
    ).toBe("Types · Lint · Tests passed. Design has nothing to compare against. Conventions passed.");
  });

  it("says why the tests could not be run, rather than that they had nothing to check", () => {
    expect(
      checksSentence([
        { gate: "typecheck", outcome: "skipped", note: null },
        { gate: "tests", outcome: "skipped", note: "No test suite Signet knows how to run was found." },
      ]),
    ).toBe("Types had nothing to check. Tests could not be run: No test suite Signet knows how to run was found.");
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

  it("offers to dismiss a failure, and only a failure, and says so to the server", async () => {
    body = desk([base, { ...base, kind: "failed", incrementId: "11111111-aaaa-4bbb-8ccc-000000000003" as Decision["incrementId"], text: "aborted by user" }]);
    render(wrap(<Desk />));
    const dismiss = await screen.findAllByText("Dismiss");
    expect(dismiss).toHaveLength(1);
    body = { dismissed: true };
    fireEvent.click(dismiss[0]!);
    await vi.waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === "/api/increments/11111111-aaaa-4bbb-8ccc-000000000003/dismiss" && init?.method === "POST")).toBe(true),
    );
  });

  it("says nothing needs you when nothing does", async () => {
    body = desk([]);
    render(wrap(<Desk />));
    expect(await screen.findByText("Nothing needs you.")).toBeTruthy();
  });
});

describe("routines, drawn as a canvas", () => {
  const recipes = [
    { id: "r1", name: "Cover an untested module", goalMd: "x".repeat(20), repoPath: null, repoOrigin: "local" as const, repoLabel: "cartographer", placeholders: [], createdAt: new Date().toISOString() },
    { id: "r2", name: "Tidy what lint flags", goalMd: "x".repeat(20), repoPath: null, repoOrigin: "local" as const, repoLabel: "cartographer", placeholders: [], createdAt: new Date().toISOString() },
  ];
  const nightly = {
    trigger: { kind: "schedule" as const, every: "day" as const, atHour: 3, atMinute: 0, onWeekday: 1 },
    steps: [
      { id: "s1", recipeId: "r1", recipeName: "Cover an untested module" },
      { id: "s2", recipeId: "r2", recipeName: "Tidy what lint flags" },
    ],
  };

  it("lays the recipes out in order, each stopping at your seal, and ends the firing", () => {
    const { nodes, edges } = routineGraph({ routine: nightly, recipes, selected: "step:s1", dropping: false, firing: null });
    expect(nodes.map((n) => n.id)).toEqual(["when", "step:s1", "step:s2", "end"]);
    expect(nodes[0]?.data.title).toBe("Every night at 3:00");
    expect(nodes.filter((n) => n.data.kind === "do").every((n) => n.data.pip === "your seal")).toBe(true);
    expect(nodes.find((n) => n.id === "step:s1")?.selected).toBe(true);
    expect(edges.map((e) => [e.source, e.target, e.label ?? null])).toEqual([
      ["when", "step:s1", null],
      ["step:s1", "step:s2", "then"],
      ["step:s2", "end", null],
    ]);
    // The order of the cards is the routine: each sits lower than the one before.
    const ys = nodes.map((n) => n.position.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it("draws the loop only for an event the routine's own work can cause", () => {
    const failing = { ...nightly, trigger: { kind: "event" as const, event: "run_failed" as const } };
    const loop = routineGraph({ routine: failing, recipes, selected: null, dropping: false, firing: null }).edges.find((e) => e.id === "loop");
    expect(loop).toMatchObject({ source: "step:s2", target: "when", label: "its own work can fail too" });
    const landed = { ...nightly, trigger: { kind: "event" as const, event: "step_merged" as const } };
    expect(routineGraph({ routine: landed, recipes, selected: null, dropping: false, firing: null }).edges.some((e) => e.id === "loop")).toBe(false);
  });

  it("draws a past firing over the same cards: the only colour is work waiting for you", () => {
    const firing = {
      id: "f1",
      triggeredBy: "schedule" as const,
      status: "succeeded" as const,
      skipReason: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      costUsd: 0.38,
      steps: [
        { stepId: "s1", recipeName: "Cover an untested module", featureId: "f", featureTitle: "Cover src/tiles.ts", incrementId: "i", now: "at your seal", yours: true, costUsd: 0.38, nothingNeeded: null, error: null },
        { stepId: "s2", recipeName: "Tidy what lint flags", featureId: null, featureTitle: null, incrementId: null, now: null, yours: false, costUsd: null, nothingNeeded: "Lint reports no warnings.", error: null },
      ],
    };
    const { nodes } = routineGraph({ routine: nightly, recipes, selected: null, dropping: false, firing });
    const [, first, second] = nodes;
    expect(first?.data).toMatchObject({ yours: true, pip: "at your seal", sub: "Started “Cover src/tiles.ts” · $0.38" });
    expect(second?.data).toMatchObject({ muted: true, sub: "Nothing to do: lint reports no warnings." });
    expect(second?.data.pip).toBeUndefined();
  });

  it("starts a new routine from a blank board", () => {
    expect(routineGraph({ routine: { trigger: null, steps: [] }, recipes, selected: null, dropping: false, firing: null }).nodes.map((n) => n.data.sub)).toEqual([
      "Drag a trigger here to start",
    ]);
  });
});
