// The shell: persistent navigation, a top bar that always says what the system
// is doing, and the content region.
//
// The old console was four screens reached through a "← board" button, so you
// could never see where you were or get anywhere in one step. Navigation is now
// always present and always shows counts, because the whole point of a console is
// that the state of the system is ambient rather than something you go and check.

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { NAV, href, navGroupOf, navigate, type Route } from "../router.js";
import { useRealtime, type ConnectionState } from "../realtime.js";
import { Badge, Button, Dot, Kbd, Row, Stack, Toggle } from "../ui/primitives.js";
import { LiveDuration } from "../ui/format.js";

const CONNECTION: Record<ConnectionState, { label: string; tone: "ok" | "warn" | "err" | "idle" }> = {
  connecting: { label: "connecting", tone: "idle" },
  live: { label: "live", tone: "ok" },
  reconnecting: { label: "reconnecting", tone: "warn" },
  offline: { label: "core unreachable", tone: "err" },
};

/** Persisted so the console opens the way the operator left it. */
function usePreference(key: string, fallback: string): [string, (v: string) => void] {
  const [value, setValue] = useState<string>(() => localStorage.getItem(key) ?? fallback);
  useEffect(() => {
    document.documentElement.dataset[key === "signet.theme" ? "theme" : "density"] = value;
    localStorage.setItem(key, value);
  }, [key, value]);
  return [value, setValue];
}

export function AppShell({
  route,
  onOpenPalette,
  children,
}: {
  route: Route;
  onOpenPalette: () => void;
  children: ReactNode;
}) {
  const [theme, setTheme] = usePreference("signet.theme", "dark");
  const [density, setDensity] = usePreference("signet.density", "comfortable");
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("signet.nav") === "collapsed");
  useEffect(() => localStorage.setItem("signet.nav", collapsed ? "collapsed" : "open"), [collapsed]);

  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 5000 });
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => api.ruleQueue(), refetchInterval: 30_000 });
  const active = navGroupOf(route);

  // undefined means "not loaded yet", which renders as no badge rather than a 0.
  const counts: Partial<Record<Route["view"], number | undefined>> = {
    work: overview.data?.counts.incrementsTotal,
    overview: overview.data?.attention.length,
    runs: overview.data?.activeRuns.length,
    constitution: rules.data?.length,
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `${collapsed ? "var(--sidebar-w-collapsed)" : "var(--sidebar-w)"} 1fr`,
        height: "100%",
        transition: "grid-template-columns var(--dur)",
      }}
    >
      <nav
        aria-label="Sections"
        style={{
          background: "var(--panel)",
          borderRight: "1px solid var(--line)",
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        <div
          style={{
            height: "var(--topbar-h)",
            display: "flex",
            alignItems: "center",
            gap: "var(--s2)",
            padding: "0 var(--s3)",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <Sigil />
          {!collapsed && <strong style={{ letterSpacing: "0.02em" }}>Signet</strong>}
        </div>

        <Stack gap="1px" style={{ padding: "var(--s2)" }}>
          {NAV.map((item) => {
            const on = active === item.view;
            const count = counts[item.view];
            return (
              <a
                key={item.view}
                href={href({ view: item.view } as Route)}
                title={collapsed ? `${item.label} — ${item.hint}` : item.hint}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--s2)",
                  padding: "6px var(--s2)",
                  borderRadius: "var(--r-sm)",
                  background: on ? "var(--accent-quiet)" : "transparent",
                  color: on ? "var(--fg)" : "var(--fg-muted)",
                  fontWeight: on ? 600 : 400,
                  textDecoration: "none",
                  justifyContent: collapsed ? "center" : "space-between",
                }}
              >
                <Row gap="var(--s2)" style={{ minWidth: 0 }}>
                  <NavGlyph view={item.view} on={on} />
                  {!collapsed && <span style={{ whiteSpace: "nowrap" }}>{item.label}</span>}
                </Row>
                {!collapsed && count !== undefined && count > 0 && (
                  <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)" }} className="num">
                    {count}
                  </span>
                )}
              </a>
            );
          })}
        </Stack>

        <div style={{ marginTop: "auto", padding: "var(--s2)", borderTop: "1px solid var(--line)" }}>
          {collapsed ? (
            <Button size="sm" variant="quiet" onClick={() => setCollapsed(false)} title="Expand navigation">
              »
            </Button>
          ) : (
            <Stack gap="var(--s2)">
              <Toggle
                checked={theme === "light"}
                onChange={(v) => setTheme(v ? "light" : "dark")}
                label="Light theme"
              />
              <Toggle
                checked={density === "compact"}
                onChange={(v) => setDensity(v ? "compact" : "comfortable")}
                label="Compact rows"
              />
              <Button size="sm" variant="quiet" onClick={() => setCollapsed(true)}>
                « collapse
              </Button>
            </Stack>
          )}
        </div>
      </nav>

      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, height: "100%" }}>
        <TopBar route={route} onOpenPalette={onOpenPalette} overview={overview.data} />
        <main style={{ overflow: "auto", flex: 1 }}>
          <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: "var(--s6) var(--s5)" }}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function TopBar({
  route,
  onOpenPalette,
  overview,
}: {
  route: Route;
  onOpenPalette: () => void;
  overview: Awaited<ReturnType<typeof api.overview>> | undefined;
}) {
  const { state } = useRealtime();
  const conn = CONNECTION[state];
  const paused = overview?.dispatcher.paused ?? false;
  const activeRun = overview?.activeRuns[0];

  return (
    <header
      style={{
        height: "var(--topbar-h)",
        borderBottom: "1px solid var(--line)",
        background: "var(--panel)",
        display: "flex",
        alignItems: "center",
        gap: "var(--s3)",
        padding: "0 var(--s5)",
        flex: "0 0 auto",
      }}
    >
      <Breadcrumbs route={route} />

      <div style={{ marginLeft: "auto" }} />

      {/* Paused is the single most important thing to know and the easiest to
          forget, so it is stated loudly wherever you are. */}
      {paused && (
        <Badge tone="warn">
          <Dot tone="warn" /> pipeline paused
        </Badge>
      )}

      {overview && overview.activeRuns.length > 0 && activeRun && (
        <Badge tone="run">
          <Dot tone="run" pulse />
          {overview.activeRuns.length === 1
            ? `${activeRun.phase.toLowerCase()} · `
            : `${overview.activeRuns.length} running · `}
          <LiveDuration since={activeRun.startedAt} />
        </Badge>
      )}

      {overview?.quota.exhausted && (
        <Badge tone="err">
          <Dot tone="err" /> quota exhausted
        </Badge>
      )}

      <span title={state === "live" ? "Receiving live updates from core" : "Updates may be stale"}>
        <Badge tone={conn.tone}>
          <Dot tone={conn.tone} pulse={state === "reconnecting"} /> {conn.label}
        </Badge>
      </span>

      <Button size="sm" variant="default" onClick={onOpenPalette} title="Command palette">
        Search <Kbd>⌘K</Kbd>
      </Button>
      <Button size="sm" variant="primary" onClick={() => navigate({ view: "new" })}>
        New feature
      </Button>
    </header>
  );
}

function Breadcrumbs({ route }: { route: Route }) {
  const group = navGroupOf(route);
  const item = NAV.find((n) => n.view === group);
  return (
    <Row gap="var(--s2)" style={{ minWidth: 0 }}>
      <span style={{ fontWeight: 600 }}>{item?.label ?? "Overview"}</span>
      {route.view === "feature" && (
        <>
          <span style={{ color: "var(--fg-subtle)" }}>/</span>
          <span style={{ color: "var(--fg-muted)" }}>feature</span>
        </>
      )}
      {route.view === "new" && (
        <>
          <span style={{ color: "var(--fg-subtle)" }}>/</span>
          <span style={{ color: "var(--fg-muted)" }}>new</span>
        </>
      )}
    </Row>
  );
}

/** The mark: a signet ring's stamp. Drawn rather than shipped as an asset. */
function Sigil() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden style={{ flex: "0 0 auto" }}>
      <circle cx="9" cy="9" r="7.5" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      <path d="M6 9.2l2.2 2.2L12.2 7" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Small distinct glyphs so the collapsed rail stays usable. */
function NavGlyph({ view, on }: { view: Route["view"]; on: boolean }) {
  const c = on ? "var(--accent)" : "var(--fg-subtle)";
  const common = { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", stroke: c, strokeWidth: 1.6 } as const;
  switch (view) {
    case "overview":
      return (
        <svg {...common} aria-hidden>
          <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" />
          <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" />
          <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" />
          <rect x="8" y="8" width="4.5" height="4.5" rx="1" />
        </svg>
      );
    case "work":
      return (
        <svg {...common} aria-hidden>
          <path d="M2 3.5h10M2 7h10M2 10.5h6" strokeLinecap="round" />
        </svg>
      );
    case "runs":
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="5.2" />
          <path d="M7 4.2V7l2 1.4" strokeLinecap="round" />
        </svg>
      );
    case "constitution":
      return (
        <svg {...common} aria-hidden>
          <path d="M3.5 2h7v10l-3.5-2-3.5 2z" strokeLinejoin="round" />
        </svg>
      );
    case "activity":
      return (
        <svg {...common} aria-hidden>
          <path d="M1.5 7.5h3L6 4.5l2 5 1.5-2.5h3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "system":
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="2" />
          <path d="M7 1.5v2M7 10.5v2M1.5 7h2M10.5 7h2" strokeLinecap="round" />
        </svg>
      );
    default:
      return <svg {...common} aria-hidden />;
  }
}
