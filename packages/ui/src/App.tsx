// The app: route → screen, inside the shell, with the palette and the global
// keyboard shortcuts.
//
// The route switch is exhaustive over the union, so adding a route without a
// screen is a compile error rather than a blank page.

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { parseRoute, type Route } from "./router.js";
import { AppShell } from "./shell/AppShell.js";
import { CommandPalette } from "./shell/CommandPalette.js";
import { ShortcutHelp, useShortcuts } from "./shell/shortcuts.js";
import { Overview } from "./screens/Overview.js";
import { Work } from "./screens/Work.js";
import { Feature } from "./screens/Feature.js";
import { Runs } from "./screens/Runs.js";
import { Constitution } from "./screens/Constitution.js";
import { Activity } from "./screens/Activity.js";
import { Graph } from "./screens/Graph.js";
import { System } from "./screens/System.js";
import { NewFeature } from "./screens/NewFeature.js";

/**
 * Loaded on demand, because it is the only screen that pulls in React Flow — about
 * 200kB, which is 45% of the whole bundle for one screen most sessions never open.
 * Everything else stays in the initial load; this arrives when you navigate to it.
 */
const Automations = lazy(() =>
  import("./screens/Automations.js").then((m) => ({ default: m.Automations })),
);

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const onHash = () => {
      setRoute(parseRoute(location.hash));
      // A route change should start at the top; otherwise the previous screen's
      // scroll position lands you halfway down the new one. Guarded because a
      // throw here would break navigation itself, and scrollTo is not present in
      // every environment this code runs in.
      const main = document.querySelector("main");
      if (main && typeof main.scrollTo === "function") main.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  useShortcuts({
    onPalette: openPalette,
    onHelp: () => setHelpOpen((v) => !v),
    disabled: paletteOpen,
  });

  return (
    <>
      <AppShell route={route} onOpenPalette={openPalette}>
        <Screen route={route} />
      </AppShell>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}

function Screen({ route }: { route: Route }) {
  switch (route.view) {
    case "overview":
      return <Overview />;
    case "work":
      return <Work route={route} />;
    case "feature":
      return <Feature route={route} />;
    case "runs":
      return <Runs route={route} />;
    case "constitution":
      return <Constitution route={route} />;
    case "activity":
      return <Activity />;
    case "graph":
      return <Graph />;
    case "system":
      return <System />;
    case "automations":
      return (
        // A plain line rather than a skeleton: the chunk is small enough that a
        // skeleton would flash and be more distracting than a word.
        <Suspense fallback={<div style={{ color: "var(--fg-muted)" }}>Loading…</div>}>
          <Automations />
        </Suspense>
      );
    case "new":
      return <NewFeature />;
    default:
      return assertNever(route);
  }
}

function assertNever(route: never): never {
  throw new Error(`unhandled route: ${JSON.stringify(route)}`);
}
