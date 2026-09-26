// Hash routing, typed. Still no router dependency — the route space is small and
// closed — but every route is now a discriminated union member, so a screen
// cannot read a parameter the route does not have, and adding a route without
// handling it is a type error.
//
// Deep links matter on an operator surface: "look at this run" has to be a URL
// you can paste into a message, which means filter and selection state lives in
// the hash rather than in component state.

export type Route =
  | { view: "overview" }
  | { view: "work"; status?: string; q?: string }
  | { view: "feature"; id: string; tab?: string }
  | { view: "runs"; outcome?: string; selected?: string }
  | { view: "constitution"; status?: string }
  | { view: "activity" }
  | { view: "graph" }
  | { view: "system" }
  | { view: "new" };

export const NAV: readonly { view: Route["view"]; label: string; hint: string }[] = [
  { view: "overview", label: "Overview", hint: "Health, what needs you, what is running" },
  { view: "work", label: "Work", hint: "Every feature and increment" },
  { view: "runs", label: "Runs", hint: "Every run, with its full anatomy" },
  { view: "constitution", label: "Constitution", hint: "Learned rules awaiting your judgement" },
  { view: "graph", label: "Graph", hint: "The context graph of everything learned" },
  { view: "activity", label: "Activity", hint: "What the system has been doing" },
  { view: "system", label: "System", hint: "How this instance is wired" },
];

/** Route → hash, the only place URLs are constructed. */
export function href(route: Route): string {
  switch (route.view) {
    case "overview":
      return "#/";
    case "work": {
      const p = new URLSearchParams();
      if (route.status && route.status !== "all") p.set("status", route.status);
      if (route.q) p.set("q", route.q);
      const q = p.toString();
      return q ? `#/work?${q}` : "#/work";
    }
    case "feature":
      return `#/work/${route.id}${route.tab && route.tab !== "increments" ? `?tab=${route.tab}` : ""}`;
    case "runs": {
      const p = new URLSearchParams();
      if (route.outcome && route.outcome !== "all") p.set("outcome", route.outcome);
      if (route.selected) p.set("run", route.selected);
      const q = p.toString();
      return q ? `#/runs?${q}` : "#/runs";
    }
    case "constitution":
      return route.status && route.status !== "PROPOSED" ? `#/constitution?status=${route.status}` : "#/constitution";
    case "activity":
      return "#/activity";
    case "graph":
      return "#/graph";
    case "system":
      return "#/system";
    case "new":
      return "#/new";
  }
}

export function navigate(route: Route): void {
  location.hash = href(route);
}

/** Hash → route, tolerant of anything: an unknown hash lands on the overview. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = raw.split("?");
  const p = new URLSearchParams(query);
  const seg = path.split("/").filter(Boolean);

  if (seg.length === 0) return { view: "overview" };

  switch (seg[0]) {
    case "work": {
      const id = seg[1];
      if (id) {
        const tab = p.get("tab");
        return { view: "feature", id, ...(tab ? { tab } : {}) };
      }
      const status = p.get("status");
      const q = p.get("q");
      return { view: "work", ...(status ? { status } : {}), ...(q ? { q } : {}) };
    }
    case "runs": {
      const outcome = p.get("outcome");
      const selected = p.get("run");
      return { view: "runs", ...(outcome ? { outcome } : {}), ...(selected ? { selected } : {}) };
    }
    case "constitution": {
      const status = p.get("status");
      return { view: "constitution", ...(status ? { status } : {}) };
    }
    case "activity":
      return { view: "activity" };
    case "graph":
      return { view: "graph" };
    case "system":
      return { view: "system" };
    case "new":
      return { view: "new" };
    default:
      return { view: "overview" };
  }
}

/** Which nav entry should look active for a given route. */
export function navGroupOf(route: Route): Route["view"] {
  if (route.view === "feature" || route.view === "new") return "work";
  return route.view;
}
