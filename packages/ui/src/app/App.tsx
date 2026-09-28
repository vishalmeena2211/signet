// The console: three places, one verb, and the sheets that open over a feature.

import { useEffect, useState, type ReactNode } from "react";
import { navigate, useRoute } from "./router.js";
import { Desk } from "./desk.js";
import { Thread } from "./thread.js";
import { Watch } from "./watch.js";
import { Flow } from "./flow.js";
import { Workshop } from "./workshop.js";
import { Ask } from "./ask.js";
import { Welcome } from "./welcome.js";
import { CommandBar } from "./cmdk.js";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";

export function App(): ReactNode {
  const route = useRoute();
  const [cmdk, setCmdk] = useState(false);

  // N asks; ⌘K / Ctrl-K opens the command bar. Never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdk((v) => !v);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n") {
        e.preventDefault();
        navigate({ view: "ask" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // A fresh instance with nothing built yet starts at the first-run question.
  const features = useQuery({ queryKey: ["features"], queryFn: api.features });
  const fresh = features.data !== undefined && features.data.length === 0;

  const page = pageFor(route, fresh);
  return (
    <>
      {page}
      {cmdk && <CommandBar onClose={() => setCmdk(false)} />}
    </>
  );
}

function pageFor(route: ReturnType<typeof useRoute>, fresh: boolean): ReactNode {
  if (fresh && route.view === "desk") return <Welcome route={{ view: "welcome" }} />;
  switch (route.view) {
    case "desk":
      return <Desk />;
    case "thread":
      return <Thread key={route.featureId} route={route} />;
    case "watch":
      return <Watch route={route} />;
    case "flow":
      return <Flow route={route} />;
    case "workshop":
      return <Workshop route={route} />;
    case "ask":
      return <Ask />;
    case "welcome":
      return <Welcome route={route} />;
  }
}
