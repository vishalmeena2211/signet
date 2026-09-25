// Boot configuration. Validated at startup; the process refuses to start on
// an incomplete config (the getEnv lesson: a throwing accessor beats a
// silently-undefined one, and a boot-time parse beats both).

import { z } from "zod";

export const SignetConfigSchema = z.object({
  // ── server ──
  host: z.string().default("127.0.0.1"), // loopback by default; never 0.0.0.0 silently
  port: z.coerce.number().int().min(1).max(65535).default(4700),
  allowedHostnames: z.array(z.string()).default([]), // host-header guard allowlist (DNS-rebinding defence)

  // ── database ──
  databaseUrl: z.string().min(1),

  // ── workspaces / target ──
  workspacesRoot: z.string().min(1), // parent dir for per-increment worktrees
  targetRepoPath: z.string().min(1), // Phase 0: one target repository
  baseRef: z.string().default("main"),
  packsRoot: z.string().min(1),

  // ── adapter ──
  claudeBinary: z.string().default("claude"),
  maxConcurrentWorkers: z.coerce.number().int().min(1).max(16).default(2),

  // ── run discipline (constitution values; overridable per deployment, not per run) ──
  maxRepairIterations: z.coerce.number().int().min(1).max(3).default(3),
  maxFreshRestarts: z.coerce.number().int().min(0).max(1).default(1),

  // ── telemetry ──
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});
export type SignetConfig = z.infer<typeof SignetConfigSchema>;

/** Parse config from an env-shaped record. Throws with a readable report on failure. */
export function parseConfig(env: Record<string, string | undefined>): SignetConfig {
  const candidate = {
    host: env["SIGNET_HOST"],
    port: env["SIGNET_PORT"],
    allowedHostnames: env["SIGNET_ALLOWED_HOSTNAMES"]?.split(",").map((s) => s.trim()).filter(Boolean),
    databaseUrl: env["SIGNET_DATABASE_URL"],
    workspacesRoot: env["SIGNET_WORKSPACES_ROOT"],
    targetRepoPath: env["SIGNET_TARGET_REPO_PATH"],
    baseRef: env["SIGNET_BASE_REF"],
    packsRoot: env["SIGNET_PACKS_ROOT"],
    claudeBinary: env["SIGNET_CLAUDE_BINARY"],
    maxConcurrentWorkers: env["SIGNET_MAX_CONCURRENT_WORKERS"],
    maxRepairIterations: env["SIGNET_MAX_REPAIR_ITERATIONS"],
    maxFreshRestarts: env["SIGNET_MAX_FRESH_RESTARTS"],
    logLevel: env["SIGNET_LOG_LEVEL"],
  };
  // Drop undefined so zod defaults apply.
  const cleaned = Object.fromEntries(Object.entries(candidate).filter(([, v]) => v !== undefined));
  const result = SignetConfigSchema.safeParse(cleaned);
  if (!result.success) {
    const report = result.error.issues
      .map((i) => `  SIGNET_${i.path.join("_").toUpperCase()}: ${i.message}`)
      .join("\n");
    throw new Error(`signet: refusing to start — invalid configuration:\n${report}`);
  }
  return result.data;
}
