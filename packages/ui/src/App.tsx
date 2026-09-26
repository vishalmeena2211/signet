// The app: route → screen, inside the shell, with the palette and the global
// keyboard shortcuts.
//
// The route switch is exhaustive over the union, so adding a route without a
// screen is a compile error rather than a blank page.

import { useCallback, useEffect, useState } from "react";
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
import { System } from "./screens/System.js";
import { NewFeature } from "./screens/NewFeature.js";

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
    case "system":
      return <System />;
    case "new":
      return <NewFeature />;
    default:
      return assertNever(route);
  }
}

function assertNever(route: never): never {
  throw new Error(`unhandled route: ${JSON.stringify(route)}`);
}
