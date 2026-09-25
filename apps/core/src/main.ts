// Boot: parse config (or refuse), host-header guard from the FIRST commit
// (DNS-rebinding defence — loopback default, explicit allowlist otherwise),
// static console serving, WebSocket attach, graceful shutdown.

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response, NextFunction } from "express";
import { parseConfig } from "@signet/contracts";
import { AppModule } from "./app.module.js";
import { Realtime } from "./http/realtime.gateway.js";
import { TOKENS } from "./http/api.controller.js";

async function bootstrap() {
  const cfg = parseConfig(process.env); // refuses to start on bad config

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  app.enableShutdownHooks();

  // Host-header guard: an unauthenticated browser can be tricked into
  // resolving an attacker domain to 127.0.0.1 (DNS rebinding). Only known
  // hostnames pass; everything else is rejected before any handler runs.
  const allowed = new Set<string>(["localhost", "127.0.0.1", "::1", cfg.host, ...cfg.allowedHostnames]);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers.host ?? "";
    const hostname = raw.includes(":") && !raw.startsWith("[") ? (raw.split(":")[0] ?? "") : raw;
    if (!allowed.has(hostname.toLowerCase())) {
      res.status(403).json({ error: "host not allowed" });
      return;
    }
    next();
  });

  // Serve the built console when present (packages/ui/dist).
  const here = dirname(fileURLToPath(import.meta.url));
  const uiDist = join(here, "..", "..", "..", "packages", "ui", "dist");
  if (existsSync(uiDist)) {
    app.useStaticAssets(uiDist);
    // SPA fallback for client routes (not /api, not /ws)
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === "GET" && !req.path.startsWith("/api") && !req.path.startsWith("/ws") && !req.path.includes(".")) {
        res.sendFile(join(uiDist, "index.html"));
        return;
      }
      next();
    });
  }

  const server = await app.listen(cfg.port, cfg.host);
  const realtime = app.get<Realtime>(TOKENS.realtime);
  realtime.attach(server);

  process.stdout.write(`signet core listening on http://${cfg.host}:${cfg.port}\n`);
}

await bootstrap();
