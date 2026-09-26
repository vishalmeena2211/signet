// Does the console actually render, and does every screen survive being opened.
//
// A typecheck proves the code is well-typed, not that it mounts — a missing
// provider or a bad property access is a blank white page that compiles fine. So
// this boots the real App against a stubbed API and walks every route, which is
// the check a browser would have given us.
//
// It also pins the failure behaviour that matters most: when core is unreachable,
// the console must SAY so. Silently showing a stale or empty screen is the worst
// outcome for an operator surface, because everything looks fine.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { App } from "./App.js";
import { ToastHost } from "./ui/feedback.js";

// ── a stub core ──

const OVERVIEW = {
  quota: { windowKind: "five_hour", exhausted: false, activeWorkers: 0 },
  dispatcher: { paused: false, maxWorkers: 2, activeWorkers: 0 },
  counts: { features: 2, incrementsTotal: 3, incrementsMerged: 1, incrementsInFlight: 0, incrementsBlocked: 0 },
  attention: [
    {
      featureId: "096a877b-a07f-4107-8824-7374b81ce5e8",
      featureTitle: "Hero banner",
      incrementId: "0e661eee-7fda-472c-8f01-a3411b856555",
      incrementTitle: "hero() with a background colour",
      reason: "awaiting_merge",
      detail: "Passed every gate — needs signature 2.",
      since: new Date(Date.now() - 300_000).toISOString(),
    },
  ],
  activeRuns: [],
  spend: [{ label: "24 hours", runs: 2, inputTokens: 2458, cachedInputTokens: 100, outputTokens: 5346, costUsd: 0.4357 }],
  reliability: { sample: 4, succeeded: 3, failed: 1, aborted: 0 },
};

const FEATURES = [
  {
    id: "096a877b-a07f-4107-8824-7374b81ce5e8",
    title: "Hero banner",
    needsHuman: true,
    needsHumanWhy: "An increment passed all gates — review and merge.",
    stage: "IMPLEMENTING",
    incrementsTotal: 1,
    incrementsMerged: 0,
  },
];

const RUNS = [
  {
    id: "61e6de45-58a0-4678-b97a-86d8564a6858",
    incrementId: "0e661eee-7fda-472c-8f01-a3411b856555",
    incrementTitle: "hero() with a background colour",
    featureId: "096a877b-a07f-4107-8824-7374b81ce5e8",
    featureTitle: "Hero banner",
    outcome: "succeeded",
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    finishedAt: new Date(Date.now() - 60_000).toISOString(),
    durationMs: 62_218,
    phaseCount: 7,
    maxAttempt: 1,
    gateRounds: 1,
    repairs: 0,
    inputTokens: 2458,
    outputTokens: 5346,
    costUsd: 0.4357,
    gatesFailed: [],
    gatesRepaired: [],
  },
];

const SYSTEM = {
  contractsVersion: "0.0.1",
  nodeVersion: "v24.15.0",
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  uptimeSeconds: 60,
  config: {
    host: "127.0.0.1",
    port: 4700,
    targetRepoPath: "/Users/x/.signet/demo-repo",
    baseRef: "main",
    workspacesRoot: "/Users/x/.signet/workspaces",
    packsRoot: "/Users/x/.signet/packs",
    claudeBinary: "claude",
    model: null,
    maxConcurrentWorkers: 2,
    maxRepairIterations: 3,
    logLevel: "info",
  },
  checks: [{ name: "database", ok: true, detail: "PostgreSQL 18.4" }],
};

const ACTIVITY = [
  {
    at: new Date(Date.now() - 30_000).toISOString(),
    kind: "gate.verdict",
    summary: "hero() with a background colour: conformance pass",
    severity: "success",
    featureId: "096a877b-a07f-4107-8824-7374b81ce5e8",
    incrementId: "0e661eee-7fda-472c-8f01-a3411b856555",
    runId: "61e6de45-58a0-4678-b97a-86d8564a6858",
  },
];

const ROUTES: Record<string, unknown> = {
  "/api/overview": OVERVIEW,
  "/api/features": FEATURES,
  "/api/runs": RUNS,
  "/api/system": SYSTEM,
  "/api/activity": ACTIVITY,
  "/api/dispatcher": { paused: false, maxWorkers: 2, activeWorkers: 0 },
  "/api/rules/queue": [],
  "/api/health": { ok: true, quota: OVERVIEW.quota },
};

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const body = ROUTES[url.pathname];
    if (body === undefined) {
      return new Response(JSON.stringify({ statusCode: 404, message: "not found" }), { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

/** jsdom has no WebSocket; the realtime provider must not be what breaks. */
class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
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
  vi.stubGlobal("fetch", stubFetch());
  vi.stubGlobal("WebSocket", FakeWebSocket);
  location.hash = "#/";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the console mounts", () => {
  it("renders the shell with navigation and live system status", async () => {
    render(wrap(<App />));
    // Navigation is always present: this is the thing the old console lacked.
    for (const label of ["Overview", "Work", "Runs", "Constitution", "Activity", "System"]) {
      expect(screen.getByRole("link", { name: new RegExp(label) })).toBeTruthy();
    }
    // "Needs you" appears as both a stat and a section heading, so target the heading.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Needs you" })).toBeTruthy());
  });

  it("puts the needs-you queue first, with an action on it", async () => {
    render(wrap(<App />));
    // The focal heading is the screen's subject, and the queue sits under it.
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Needs you" })).toBeTruthy());
    // Every waiting item says what it needs and offers the action that resolves it.
    expect(screen.getByText(/needs signature 2/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Review & merge/ })).toBeTruthy();
    // And how long it has been waiting, because a queue you cannot see ageing grows.
    expect(screen.getByText(/ago/)).toBeTruthy();
  });

  it.each([
    ["#/work", /Hero banner/],
    ["#/runs", /succeeded/i],
    ["#/activity", /conformance pass/],
    ["#/system", /PostgreSQL 18.4/],
    ["#/constitution", /Learn a repository/],
  ])("renders %s without blowing up", async (hash, expected) => {
    location.hash = hash;
    render(wrap(<App />));
    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
  });

  it("renders the new-feature form with its validation guidance", async () => {
    location.hash = "#/new";
    render(wrap(<App />));
    // "New feature" is also the top-bar button, so match the heading.
    await waitFor(() => expect(screen.getByRole("heading", { name: "New feature" })).toBeTruthy());
    // The form says what is missing rather than just disabling the button.
    expect(screen.getByText(/Give the feature a title/)).toBeTruthy();
  });

  it("shows the real cost rather than rounding a sub-dollar run to nothing", async () => {
    location.hash = "#/runs";
    render(wrap(<App />));
    await waitFor(() => expect(screen.getByText("$0.4357")).toBeTruthy());
  });

  it("SAYS SO when core is unreachable, instead of looking fine", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    render(wrap(<App />));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/pnpm console/)).toBeTruthy();
  });

  it("reports an unknown route as the overview rather than a blank page", async () => {
    location.hash = "#/does-not-exist";
    render(wrap(<App />));
    // "Needs you" appears as both a stat and a section heading, so target the heading.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Needs you" })).toBeTruthy());
  });
});
