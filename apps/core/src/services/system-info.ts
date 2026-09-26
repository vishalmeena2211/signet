// "How is this instance actually wired, and is each part of it working."
//
// Every value here is read from the live process or probed, never from a
// constant — the point of this screen is to settle arguments about what is
// configured, so a hardcoded answer would defeat it. The checks run on request
// and report what they found, including the failure text.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { CONTRACTS_VERSION, SystemInfoSchema, type SignetConfig, type SystemCheck, type SystemInfo } from "@signet/contracts";
import type { PrismaClient } from "../persistence/generated/client.js";

const pexec = promisify(execFile);

/** Fixed at first import: close enough to process start for an uptime readout. */
const STARTED_AT = new Date();

export class SystemInfoService {
  constructor(
    private readonly cfg: SignetConfig,
    private readonly db: PrismaClient,
    /** null when no model is pinned — reported as-is, never guessed. */
    private readonly model: string | null,
  ) {}

  async info(): Promise<SystemInfo> {
    const checks = await this.runChecks();
    return SystemInfoSchema.parse({
      contractsVersion: CONTRACTS_VERSION,
      nodeVersion: process.version,
      startedAt: STARTED_AT.toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      config: {
        host: this.cfg.host,
        port: this.cfg.port,
        targetRepoPath: this.cfg.targetRepoPath,
        baseRef: this.cfg.baseRef,
        workspacesRoot: this.cfg.workspacesRoot,
        packsRoot: this.cfg.packsRoot,
        claudeBinary: this.cfg.claudeBinary,
        model: this.model,
        maxConcurrentWorkers: this.cfg.maxConcurrentWorkers,
        maxRepairIterations: this.cfg.maxRepairIterations,
        logLevel: this.cfg.logLevel,
      },
      checks,
    });
  }

  /** Each check is independent, so one failure must not hide the others. */
  private async runChecks(): Promise<SystemCheck[]> {
    const results = await Promise.all([
      this.check("database", async () => {
        const rows = await this.db.$queryRawUnsafe<{ v: string }[]>("select version() as v");
        const v = rows[0]?.v ?? "unknown";
        return v.split(" ").slice(0, 2).join(" ");
      }),
      this.check("target repository", async () => {
        const { stdout } = await pexec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: this.cfg.targetRepoPath,
        });
        const branch = stdout.trim();
        const { stdout: sha } = await pexec("git", ["rev-parse", "--short", "HEAD"], {
          cwd: this.cfg.targetRepoPath,
        });
        return `on ${branch} at ${sha.trim()}`;
      }),
      this.check("base ref", async () => {
        await pexec("git", ["rev-parse", "--verify", this.cfg.baseRef], { cwd: this.cfg.targetRepoPath });
        return `${this.cfg.baseRef} exists`;
      }),
      this.check("claude code", async () => {
        const { stdout } = await pexec(this.cfg.claudeBinary, ["--version"]);
        return stdout.trim();
      }),
      this.check("workspaces root", async () => {
        await access(this.cfg.workspacesRoot, constants.W_OK);
        return `${this.cfg.workspacesRoot} writable`;
      }),
      this.check("packs root", async () => {
        await access(this.cfg.packsRoot, constants.W_OK);
        return `${this.cfg.packsRoot} writable`;
      }),
      this.check("console assets", async () => {
        // Served from packages/ui/dist; a missing build is why the UI would 404.
        const dist = join(process.cwd(), "..", "..", "packages", "ui", "dist", "index.html");
        await access(dist, constants.R_OK);
        return "built";
      }),
    ]);
    return results;
  }

  private async check(name: string, probe: () => Promise<string>): Promise<SystemCheck> {
    try {
      return { name, ok: true, detail: await probe() };
    } catch (e) {
      // The failure text is the useful part — it is usually the whole diagnosis.
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      return { name, ok: false, detail: msg && msg.length > 0 ? msg : "failed" };
    }
  }
}
