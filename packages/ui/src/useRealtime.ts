// WebSocket → React Query invalidation. Server truth only; the client never
// holds business state of its own.

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RealtimeEventSchema } from "@signet/contracts";

export function useRealtime(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (msg) => {
      const parsed = RealtimeEventSchema.safeParse(JSON.parse(String(msg.data))); // signet-policy-allow: raw-json-parse -- validated on this line
      if (!parsed.success) return;
      const ev = parsed.data;
      switch (ev.kind) {
        case "increment_changed":
        case "feature_changed":
          void qc.invalidateQueries({ queryKey: ["features"] });
          void qc.invalidateQueries({ queryKey: ["feature"] });
          break;
        case "needs_you":
          void qc.invalidateQueries();
          break;
        case "quota_changed":
          void qc.invalidateQueries({ queryKey: ["health"] });
          break;
      }
    };
    return () => ws.close();
  }, [qc]);
}
