// Prisma 7 config: connection URL lives here (for CLI/migrate); the runtime
// client connects through a driver adapter constructed in persistence.
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // signet-policy-allow: raw-env -- CLI-only file; the server's config path is contracts/parseConfig
    url: process.env["SIGNET_DATABASE_URL"] ?? "postgresql://signet:signet@127.0.0.1:5765/signet",
  },
});
