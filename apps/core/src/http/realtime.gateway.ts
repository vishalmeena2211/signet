// WebSocket fan-out for the console: the server pushes RealtimeEvents; the UI
// invalidates its queries. Plain `ws` — no rooms, no auth beyond the host
// binding (loopback by default), Phase 0 scope.

import { WebSocketServer } from "ws";
import type { Server } from "node:http";
import { RealtimeEventSchema, type RealtimeEvent } from "@signet/contracts";
import type { Logger } from "../domain/runtime/logger.js";

export class Realtime {
  private wss: WebSocketServer | null = null;

  constructor(private readonly log: Logger) {}

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", () => this.log.debug("ws.connected"));
  }

  broadcast(event: RealtimeEvent): void {
    const valid = RealtimeEventSchema.parse(event);
    const payload = JSON.stringify(valid);
    for (const client of this.wss?.clients ?? []) {
      if (client.readyState === 1) client.send(payload);
    }
  }
}
