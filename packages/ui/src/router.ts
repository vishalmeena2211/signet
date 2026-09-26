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
  | { view: "automations" }
  | { view: "new" };

export const NAV: readonly { view: Route["view"]; label: string; hint: string }[] = [
  { view: "overview", label: "Overview", hint: "What needs you, and what is running" },
  { view: "work", label: "Work", hint: "Everything being built" },
  { view: "runs", label: "Runs", hint: "Every attempt, and how it went" },
  { view: "constitution", label: "Rules", hint: "What Signet learned from your code" },
  { view: "graph", label: "Graph", hint: "How everything Signet learned connects" },
  { view: "automations", label: "Automations", hint: "Saved requests, and what runs them on a schedule" },
  { view: "activity", label: "Activity", hint: "What the system has been doing" },
  { view: "system", label: "System", hint: "How this copy of Signet is set up" },
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
    case "automations":
      return "#/automations";
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
    case "automations":
      return { view: "automations" };
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
