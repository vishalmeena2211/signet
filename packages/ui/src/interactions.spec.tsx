// The things an operator does with their hands.
//
// Every control here was either a bug once or is the kind that becomes one
// quietly: a palette that steals keystrokes from a text field, a destructive
// button with no confirmation, a confirmation that stays armed forever, a pause
// that silently does nothing. These pin the behaviour, not the pixels.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { App } from "./App.js";
import { ToastHost } from "./ui/feedback.js";
import { ConfirmButton } from "./ui/feedback.js";

const OVERVIEW = {
  quota: { windowKind: "five_hour", exhausted: false, activeWorkers: 0 },
  dispatcher: { paused: false, maxWorkers: 2, activeWorkers: 0 },
  counts: { features: 1, incrementsTotal: 1, incrementsMerged: 0, incrementsInFlight: 0, incrementsBlocked: 0 },
  attention: [],
  activeRuns: [],
  spend: [{ label: "24 hours", runs: 1, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, costUsd: 0.1 }],
  reliability: { sample: 1, succeeded: 1, failed: 0, aborted: 0 },
};

const FEATURES = [
  {
    id: "096a877b-a07f-4107-8824-7374b81ce5e8",
    title: "Hero banner",
    needsHuman: false,
    stage: "IMPLEMENTING",
    incrementsTotal: 1,
    incrementsMerged: 0,
    stepStates: ["RUNNING"],
    repoLabel: null,
  },
  {
    id: "196a877b-a07f-4107-8824-7374b81ce5e9",
    title: "Checkout totals",
    needsHuman: false,
    stage: "DONE",
    incrementsTotal: 2,
    incrementsMerged: 2,
    stepStates: ["MERGED", "MERGED"],
    repoLabel: "~/code/checkout",
  },
];

let dispatcherState = { paused: false, maxWorkers: 2, activeWorkers: 0 };
const posted: { path: string; body: unknown }[] = [];

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    setTimeout(() => this.onopen?.(), 0);
  }
  close() {}
}

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ToastHost>{children}</ToastHost>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  posted.length = 0;
  dispatcherState = { paused: false, maxWorkers: 2, activeWorkers: 0 };
  localStorage.clear();
  location.hash = "#/";
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (init?.method === "POST") {
        // signet-policy-allow: raw-json-parse -- test stub inspecting the request it was just handed
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        posted.push({ path, body });
        if (path === "/api/dispatcher") {
          dispatcherState = { ...dispatcherState, ...(body as object) };
          return new Response(JSON.stringify(dispatcherState), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }
      const bodies: Record<string, unknown> = {
        "/api/overview": { ...OVERVIEW, dispatcher: dispatcherState },
        "/api/features": FEATURES,
        "/api/runs": [],
        "/api/activity": [],
        "/api/rules/queue": [],
        "/api/dispatcher": dispatcherState,
      };
      const body = bodies[path];
      if (body === undefined) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("command palette", () => {
  it("opens with ⌘K and closes with Escape", async () => {
    render(wrap(<App />));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.getByRole("dialog", { name: /Command palette/ })).toBeTruthy());
    fireEvent.keyDown(screen.getByPlaceholderText(/Search features/), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Command palette/ })).toBeNull());
  });

  it("also opens with Ctrl-K, for people not on a Mac", async () => {
    render(wrap(<App />));
    fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("dialog", { name: /Command palette/ })).toBeTruthy());
  });

  it("searches live features alongside navigation and actions", async () => {
    render(wrap(<App />));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText(/Search features/);
    await waitFor(() => expect(screen.getByText("Checkout totals")).toBeTruthy());

    fireEvent.change(input, { target: { value: "checkout" } });
    await waitFor(() => expect(screen.queryByText("Hero banner")).toBeNull());
    expect(screen.getByText("Checkout totals")).toBeTruthy();
  });

  it("navigates to the feature chosen with the keyboard", async () => {
    render(wrap(<App />));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText(/Search features/);
    fireEvent.change(input, { target: { value: "hero" } });
    await waitFor(() => expect(screen.getByText("Hero banner")).toBeTruthy());
    fireEvent.keyDown(input, { key: "Enter" });
    expect(location.hash).toBe("#/work/096a877b-a07f-4107-8824-7374b81ce5e8");
  });

  it("says so when nothing matches, rather than showing an empty box", async () => {
    render(wrap(<App />));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText(/Search features/);
    fireEvent.change(input, { target: { value: "zzzzzz" } });
    await waitFor(() => expect(screen.getByText(/Nothing matches/)).toBeTruthy());
  });

  it("pauses the pipeline from the palette, and says what that means", async () => {
    render(wrap(<App />));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText(/Search features/);
    fireEvent.change(input, { target: { value: "pause" } });
    const action = await screen.findByText("Pause the pipeline");
    // The hint must explain that this is a hold, not a kill.
    expect(screen.getByText(/In-flight runs finish/)).toBeTruthy();
    fireEvent.click(action);
    await waitFor(() => expect(posted.some((p) => p.path === "/api/dispatcher")).toBe(true));
    expect(posted.find((p) => p.path === "/api/dispatcher")?.body).toEqual({ paused: true });
  });
});

describe("keyboard shortcuts", () => {
  it("jumps between sections with g-prefixed pairs", async () => {
    render(wrap(<App />));
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "r" });
    expect(location.hash).toBe("#/runs");

    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "s" });
    expect(location.hash).toBe("#/system");
  });

  it("forgets a stray g rather than arming a jump indefinitely", async () => {
    vi.useFakeTimers();
    try {
      render(wrap(<App />));
      fireEvent.keyDown(window, { key: "g" });
      // Long enough that the operator has forgotten they pressed it.
      act(() => void vi.advanceTimersByTime(2000));
      fireEvent.keyDown(window, { key: "r" });
      expect(location.hash).toBe("#/");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the new-feature form with n", async () => {
    render(wrap(<App />));
    fireEvent.keyDown(window, { key: "n" });
    expect(location.hash).toBe("#/new");
  });

  it("lists every shortcut with ?", async () => {
    render(wrap(<App />));
    fireEvent.keyDown(window, { key: "?" });
    await waitFor(() => expect(screen.getByRole("dialog", { name: /Keyboard shortcuts/ })).toBeTruthy());
    expect(screen.getByText(/Command palette/)).toBeTruthy();
  });

  it("does NOT steal keystrokes from a text field", async () => {
    location.hash = "#/new";
    render(wrap(<App />));
    const field = await screen.findByPlaceholderText(/Add percentage discounts/);
    // Typing "n" or "g" into a form must type, not navigate.
    fireEvent.keyDown(field, { key: "n" });
    fireEvent.keyDown(field, { key: "g" });
    expect(location.hash).toBe("#/new");
  });

  it("still opens the palette from inside a text field, since that is a global", async () => {
    location.hash = "#/new";
    render(wrap(<App />));
    const field = await screen.findByPlaceholderText(/Add percentage discounts/);
    fireEvent.keyDown(field, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.getByRole("dialog", { name: /Command palette/ })).toBeTruthy());
  });
});

describe("destructive actions are armed, not instant", () => {
  it("asks before firing, and only fires on the second press", () => {
    const onConfirm = vi.fn();
    render(
      wrap(
        <ConfirmButton question="This cannot be undone." confirmLabel="Do it" onConfirm={onConfirm}>
          Dangerous
        </ConfirmButton>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dangerous" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("This cannot be undone.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("can be backed out of", () => {
    const onConfirm = vi.fn();
    render(
      wrap(
        <ConfirmButton question="Sure?" confirmLabel="Yes" onConfirm={onConfirm}>
          Dangerous
        </ConfirmButton>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dangerous" }));
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Dangerous" })).toBeTruthy();
  });

  it("disarms itself, so a half-pressed destructive button is not left lying around", () => {
    vi.useFakeTimers();
    try {
      const onConfirm = vi.fn();
      render(
        wrap(
          <ConfirmButton question="Sure?" confirmLabel="Yes" onConfirm={onConfirm}>
            Dangerous
          </ConfirmButton>,
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Dangerous" }));
      expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
      act(() => void vi.advanceTimersByTime(7000));
      expect(screen.getByRole("button", { name: "Dangerous" })).toBeTruthy();
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pipeline control from the Overview", () => {
  it("requires confirmation to pause, then reports the new state", async () => {
    render(wrap(<App />));
    const pause = await screen.findByRole("button", { name: "Pause pipeline" });
    fireEvent.click(pause);
    // States the consequence before doing it, in both halves: what keeps going and
    // what stops.
    expect(screen.getByText(/Work already running finishes/i)).toBeTruthy();
    expect(screen.getByText(/nothing new starts/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause it" }));

    await waitFor(() => expect(posted.find((p) => p.path === "/api/dispatcher")?.body).toEqual({ paused: true }));
    // And the operator is told, not left guessing.
    await waitFor(() => expect(screen.getByText(/Pipeline paused/)).toBeTruthy());
  });

  it("changes the worker ceiling without a confirmation, because it is reversible", async () => {
    render(wrap(<App />));
    const lower = await screen.findByTitle(/Run fewer at once/);
    fireEvent.click(lower);
    await waitFor(() => expect(posted.find((p) => p.path === "/api/dispatcher")?.body).toEqual({ maxWorkers: 1 }));
  });

  it("will not lower the ceiling below one worker", async () => {
    dispatcherState = { paused: false, maxWorkers: 1, activeWorkers: 0 };
    render(wrap(<App />));
    const lower = await screen.findByTitle(/Run fewer at once/);
    expect((lower as HTMLButtonElement).disabled).toBe(true);
  });
});
