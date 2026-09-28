// Routes for the three places and the one verb. Hash routing, typed: every route is a
// union member, so a screen cannot read a parameter its route does not have.
//
// The signing sheets are part of the route, not component state, because "look at
// this" has to be a link: a seal waiting for you is something you send someone.

import { useEffect, useState } from "react";

export type Sheet = { kind: "initial" | "seal"; step: string; tab?: "promises" | "change" | "story" | undefined };

export type Route =
  | { view: "desk" }
  | { view: "ask" }
  | { view: "thread"; featureId: string; sheet?: Sheet | undefined; from?: "desk" | "flow" | undefined }
  | { view: "watch"; featureId: string; step: string }
  | { view: "flow"; tab: "motion" | "ledger"; open?: string | undefined }
  | { view: "workshop"; tab: "conventions" | "routines" | "health" }
  | { view: "welcome"; repoId?: string };

export function href(r: Route): string {
  switch (r.view) {
    case "desk":
      return "#/";
    case "ask":
      return "#/ask";
    case "thread": {
      const p = new URLSearchParams();
      if (r.sheet) {
        p.set("sheet", r.sheet.kind);
        p.set("step", r.sheet.step);
        if (r.sheet.tab && r.sheet.tab !== "promises") p.set("tab", r.sheet.tab);
      }
      if (r.from === "flow") p.set("from", "flow");
      const q = p.toString();
      return `#/f/${r.featureId}${q ? `?${q}` : ""}`;
    }
    case "watch":
      return `#/f/${r.featureId}/watch/${r.step}`;
    case "flow":
      return r.tab === "ledger" ? `#/flow/ledger${r.open ? `?open=${r.open}` : ""}` : "#/flow";
    case "workshop":
      return `#/workshop/${r.tab}`;
    case "welcome":
      return r.repoId ? `#/welcome/${encodeURIComponent(r.repoId)}` : "#/welcome";
  }
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = raw.split("?");
  const p = new URLSearchParams(query);
  const seg = path.split("/").filter(Boolean).map(decodeURIComponent);

  if (seg.length === 0) return { view: "desk" };
  switch (seg[0]) {
    case "ask":
      return { view: "ask" };
    case "f": {
      const featureId = seg[1];
      if (!featureId) return { view: "desk" };
      if (seg[2] === "watch" && seg[3]) return { view: "watch", featureId, step: seg[3] };
      const kind = p.get("sheet");
      const step = p.get("step");
      const tab = p.get("tab");
      const sheet: Sheet | undefined =
        (kind === "initial" || kind === "seal") && step
          ? { kind, step, tab: tab === "change" || tab === "story" ? tab : "promises" }
          : undefined;
      return { view: "thread", featureId, sheet, from: p.get("from") === "flow" ? "flow" : "desk" };
    }
    case "flow":
      return seg[1] === "ledger" ? { view: "flow", tab: "ledger", open: p.get("open") ?? undefined } : { view: "flow", tab: "motion" };
    case "workshop":
      return {
        view: "workshop",
        tab: seg[1] === "routines" ? "routines" : seg[1] === "health" ? "health" : "conventions",
      };
    case "welcome":
      return seg[1] ? { view: "welcome", repoId: seg[1] } : { view: "welcome" };
    default:
      return { view: "desk" };
  }
}

export function navigate(r: Route): void {
  location.hash = href(r);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** Which of the three places a route belongs to, for the rail. */
export function placeOf(r: Route): "desk" | "flow" | "workshop" {
  if (r.view === "flow" || r.view === "watch") return "flow";
  if (r.view === "workshop") return "workshop";
  if (r.view === "thread") return r.from === "flow" ? "flow" : "desk";
  return "desk";
}
