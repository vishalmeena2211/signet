// The live link to core.
//
// The previous version opened one WebSocket and never reconnected, so a core
// restart left the console silently frozen — showing stale data with no hint
// that it had stopped listening. That is the worst failure mode an operator
// surface can have, because everything looks fine.
//
// Now: reconnect with capped backoff, a connection state the top bar shows, and
// a refetch-everything on reconnect because whatever happened while we were away
// is exactly what we missed. The client still holds no business state of its own
// — events only invalidate queries.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RealtimeEventSchema } from "@signet/contracts";
import { useToast } from "./ui/feedback.js";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

const RealtimeCtx = createContext<{ state: ConnectionState; lastEventAt: number | null }>({
  state: "connecting",
  lastEventAt: null,
});

export function useRealtime() {
  return useContext(RealtimeCtx);
}

/** 0.5s, 1s, 2s, 4s, 8s, then every 10s — quick enough to catch a restart, slow
 *  enough not to hammer a core that is genuinely down. */
function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 10_000);
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState<ConnectionState>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  // Refs so the effect can run once and never resubscribe on every render.
  const attemptRef = useRef(0);
  const hadConnection = useRef(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function connect() {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);

      ws.onopen = () => {
        attemptRef.current = 0;
        setState("live");
        if (hadConnection.current) {
          // We were away. Anything could have changed, so trust nothing cached.
          void qc.invalidateQueries();
          toast.push("Reconnected to core", "ok");
        }
        hadConnection.current = true;
      };

      ws.onmessage = (msg) => {
        let parsed;
        try {
          parsed = RealtimeEventSchema.safeParse(JSON.parse(String(msg.data))); // signet-policy-allow: raw-json-parse -- validated on this line
        } catch {
          return; // a malformed frame is not worth a crash
        }
        if (!parsed.success) return;
        setLastEventAt(Date.now());

        const ev = parsed.data;
        switch (ev.kind) {
          case "increment_changed":
          case "feature_changed":
            // Everything that could have moved: the boards, the detail, the
            // aggregate screens that count states.
            for (const key of ["features", "feature", "overview", "runs", "activity"]) {
              void qc.invalidateQueries({ queryKey: [key] });
            }
            break;
          case "needs_you":
            void qc.invalidateQueries();
            toast.push(ev.why, "warn");
            break;
          case "quota_changed":
            for (const key of ["health", "overview", "dispatcher"]) {
              void qc.invalidateQueries({ queryKey: [key] });
            }
            break;
        }
      };

      const scheduleReconnect = () => {
        if (closed) return;
        const wait = backoffMs(attemptRef.current++);
        // After several failures, stop claiming we are merely reconnecting.
        setState(attemptRef.current > 4 ? "offline" : "reconnecting");
        timer = setTimeout(connect, wait);
      };

      ws.onclose = scheduleReconnect;
      ws.onerror = () => ws?.close();
    }

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      // Drop the handler first: onclose would otherwise schedule a reconnect
      // for a provider that is being unmounted.
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [qc, toast]);

  const value = useMemo(() => ({ state, lastEventAt }), [state, lastEventAt]);
  return <RealtimeCtx.Provider value={value}>{children}</RealtimeCtx.Provider>;
}
