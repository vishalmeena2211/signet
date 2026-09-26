// The shell must hold still, and its controls must work.
//
// The layout assertions here are not decoration. The sidebar was scrolling away
// with the page, because a flex item defaults to `min-height: auto` and therefore
// refuses to shrink below its content: `main` grew, the grid row grew past the
// viewport, and the document scrolled instead of the content area. jsdom does no
// layout, so these tests cannot catch a visual regression — but they CAN catch
// someone deleting the properties that make the fix work, which is how this bug
// would come back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AppShell } from "./AppShell.js";
import { ToastHost } from "../ui/feedback.js";
import { RealtimeProvider } from "../realtime.js";

const OVERVIEW = {
  quota: { windowKind: "five_hour", exhausted: false, activeWorkers: 0 },
  dispatcher: { paused: false, maxWorkers: 2, activeWorkers: 0 },
  counts: { features: 3, incrementsTotal: 5, incrementsMerged: 2, incrementsInFlight: 1, incrementsBlocked: 0 },
  attention: [],
  activeRuns: [],
  spend: [],
  reliability: { sample: 0, succeeded: 0, failed: 0, aborted: 0 },
};

/** Full RuleCard shape — the client parses responses, so a stub must be valid. */
const RULE = {
  id: "11111111-aaaa-4bbb-8ccc-000000000001",
  statement: "Use the --brand-primary token rather than a literal purple",
  kind: "token",
  evidence: [{ ref: "src/theme.css:12", kind: "declared", detail: "token declaration" }],
  confidence: 0.86,
  trend: "growing",
  status: "PROPOSED",
  fpCount: 0,
};

let overviewBody: unknown = OVERVIEW;

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeWebSocket.last = this;
    // Open on the next tick, the way a real socket would.
    setTimeout(() => this.onopen?.(), 0);
  }
  close() {}
}

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ToastHost>
        <RealtimeProvider>{children}</RealtimeProvider>
      </ToastHost>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  overviewBody = OVERVIEW;
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-density");
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const bodies: Record<string, unknown> = {
        "/api/overview": overviewBody,
        "/api/rules/queue": [RULE, { ...RULE, id: RULE.id.replace(/01$/, "02") }],
      };
      const body = bodies[path];
      if (body === undefined) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shell layout holds still", () => {
  it("pins the shell to the viewport and clips it, so the document cannot scroll", () => {
    const { container } = render(wrap(<AppShell route={{ view: "overview" }} onOpenPalette={() => {}}>x</AppShell>));
    const shell = container.firstElementChild as HTMLElement;
    expect(shell.style.height).toBe("100dvh");
    expect(shell.style.overflow).toBe("hidden");
  });

  it("gives ONLY main the scrollbar, with min-height:0 so it can actually shrink", () => {
    render(wrap(<AppShell route={{ view: "overview" }} onOpenPalette={() => {}}>x</AppShell>));
    const main = document.querySelector("main") as HTMLElement;
    expect(main.style.overflow).toBe("auto");
    // Without this the flex item never shrinks and the page scrolls instead.
    expect(main.style.minHeight).toBe("0px");
    // Its parent column needs the same escape hatch.
    const column = main.parentElement as HTMLElement;
    expect(column.style.minHeight).toBe("0px");
  });

  it("makes the sidebar its own scroll container rather than growing the page", () => {
    render(wrap(<AppShell route={{ view: "overview" }} onOpenPalette={() => {}}>x</AppShell>));
    const nav = screen.getByRole("navigation", { name: "Sections" });
    expect(nav.style.overflow).toBe("hidden");
    expect(nav.style.minHeight).toBe("0px");
    // The link list itself is the scroller, inside the rail.
    const list = screen.getByRole("link", { name: /Overview/ }).parentElement as HTMLElement;
    expect(list.style.overflowY).toBe("auto");
    expect(list.style.minHeight).toBe("0px");
  });
});

describe("shell navigation", () => {
  it("marks the current section, and only that one", async () => {
    render(wrap(<AppShell route={{ view: "runs" }} onOpenPalette={() => {}}>x</AppShell>));
    const runs = screen.getByRole("link", { name: /Runs/ });
    const work = screen.getByRole("link", { name: /Work/ });
    expect(runs.style.fontWeight).toBe("600");
    expect(work.style.fontWeight).toBe("400");
  });

  it("highlights Work while inside a feature, because that is where you came from", () => {
    render(wrap(<AppShell route={{ view: "feature", id: "abc" }} onOpenPalette={() => {}}>x</AppShell>));
    expect(screen.getByRole("link", { name: /Work/ }).style.fontWeight).toBe("600");
  });

  it("shows live counts beside the sections that have them", async () => {
    render(wrap(<AppShell route={{ view: "overview" }} onOpenPalette={() => {}}>x</AppShell>));
    // 5 increments total on Work, 2 queued rules on Constitution.
    await waitFor(() => expect(screen.getByRole("link", { name: /Work 5/ })).toBeTruthy());
    expect(screen.getByRole("link", { name: /Constitution 2/ })).toBeTruthy();
  });
});

describe("shell preferences persist", () => {
  it("switches theme and remembers it", () => {
    render(wrap(<AppShell route={{ view: "overview" }} onOpenPalette={() => {}}>x</AppShell>));
    const toggle = screen.getByRole("switch", { name: /Light theme/ });
    expect(document.documentElement.dataset.theme).toBe("dark");
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("signet.theme")).toBe("light");
  });

  it("switches density and remembers it", () => {
    render(wrap(<AppShell route={{ view: "overview" }} onOpenPalette={() => {}}>x</AppShell>));
    fireEvent.click(screen.getByRole("switch", { name: /Compact rows/ }));
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(localStorage.getItem("signet.density")).toBe("compact");
  });

  it("collapses to an icon rail and remembers that too", () => {
    render(wrap(<AppShell route={{ view: "overview" }} onOpenPalette={() => {}}>x</AppShell>));
    fireEvent.click(screen.getByRole("button", { name: /collapse/ }));
    expect(localStorage.getItem("signet.nav")).toBe("collapsed");
    // Labels go, but each link keeps an accessible name via its title.
    expect(screen.getByTitle(/^Runs —/)).toBeTruthy();
  });
});

describe("top bar states the truth about the system", () => {
  it("says nothing alarming when everything is healthy", async () => {
    render(wrap(<AppShell route={{ view: "overview" }} onOpenPalette={() => {}}>x</AppShell>));
    await waitFor(() => expect(screen.getByText("live")).toBeTruthy());
    expect(screen.queryByText(/pipeline paused/)).toBeNull();
    expect(screen.queryByText(/quota exhausted/)).toBeNull();
  });

  it("shouts when the pipeline is paused, wherever you are", async () => {
    overviewBody = { ...OVERVIEW, dispatcher: { paused: true, maxWorkers: 2, activeWorkers: 0 } };
    render(wrap(<AppShell route={{ view: "system" }} onOpenPalette={() => {}}>x</AppShell>));
    // Paused is the easiest state to forget and the most expensive to miss.
    await waitFor(() => expect(screen.getByText(/pipeline paused/)).toBeTruthy());
  });

  it("shows quota exhaustion, which explains why nothing is starting", async () => {
    overviewBody = {
      ...OVERVIEW,
      quota: { windowKind: "five_hour", exhausted: true, activeWorkers: 0, resetsAt: new Date().toISOString() },
    };
    render(wrap(<AppShell route={{ view: "overview" }} onOpenPalette={() => {}}>x</AppShell>));
    await waitFor(() => expect(screen.getByText(/quota exhausted/)).toBeTruthy());
  });

  it("shows the running phase and a live timer when a run is in flight", async () => {
    overviewBody = {
      ...OVERVIEW,
      activeRuns: [
        {
          runId: "11111111-aaaa-4bbb-8ccc-000000000001",
          incrementId: "11111111-aaaa-4bbb-8ccc-000000000002",
          incrementTitle: "doing the thing",
          featureId: "11111111-aaaa-4bbb-8ccc-000000000003",
          phase: "AGENT_IMPLEMENT",
          attempt: 1,
          startedAt: new Date(Date.now() - 45_000).toISOString(),
          phaseEnteredAt: new Date(Date.now() - 20_000).toISOString(),
        },
      ],
    };
    render(wrap(<AppShell route={{ view: "overview" }} onOpenPalette={() => {}}>x</AppShell>));
    await waitFor(() => expect(screen.getByText(/agent_implement/)).toBeTruthy());
  });

  it("reports the realtime link so stale data can never masquerade as fresh", async () => {
    render(wrap(<AppShell route={{ view: "overview" }} onOpenPalette={() => {}}>x</AppShell>));
    await waitFor(() => expect(screen.getByTitle(/Receiving live updates/)).toBeTruthy());
  });

  it("opens the palette from the top bar", () => {
    const onOpen = vi.fn();
    render(wrap(<AppShell route={{ view: "overview" }} onOpenPalette={onOpen}>x</AppShell>));
    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    expect(onOpen).toHaveBeenCalled();
  });
});
