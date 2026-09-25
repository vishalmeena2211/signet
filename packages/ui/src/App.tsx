// Hash-routed two-screen app: #/ board · #/f/<id> detail. No router dep —
// the surface is deliberately tiny.

import { useEffect, useState } from "react";
import { Board } from "./screens/Board.js";
import { Detail } from "./screens/Detail.js";
import { NewFeature } from "./screens/NewFeature.js";
import { Constitution } from "./screens/Constitution.js";
import { useRealtime } from "./useRealtime.js";

function parseHash():
  | { view: "board" }
  | { view: "feature"; id: string }
  | { view: "new" }
  | { view: "constitution" } {
  if (location.hash === "#/new") return { view: "new" };
  if (location.hash === "#/constitution") return { view: "constitution" };
  const m = /^#\/f\/(.+)$/.exec(location.hash);
  return m?.[1] ? { view: "feature", id: m[1] } : { view: "board" };
}

export function App() {
  const [route, setRoute] = useState(parseHash());
  useRealtime();
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (route.view === "feature") {
    return <Detail featureId={route.id} onBack={() => (location.hash = "#/")} />;
  }
  if (route.view === "new") {
    return (
      <NewFeature
        onCreated={(id) => (location.hash = `#/f/${id}`)}
        onCancel={() => (location.hash = "#/")}
      />
    );
  }
  if (route.view === "constitution") {
    return <Constitution onBack={() => (location.hash = "#/")} />;
  }
  return (
    <Board
      onOpen={(id) => (location.hash = `#/f/${id}`)}
      onNew={() => (location.hash = "#/new")}
      onConstitution={() => (location.hash = "#/constitution")}
    />
  );
}
