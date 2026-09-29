// Health: each line a fact with its value, not a tick beside the word "OK". Healthy
// lines are grey; a failing one says what it prevents and gives the exact command that
// fixes it, as text to copy rather than something Signet runs on your machine.

import { access, constants, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HealthViewSchema, type HealthView } from "@signet/contracts";
import type { z } from "zod";
import type { PrismaClient } from "../persistence/generated/client.js";
import type { BaselineChecks } from "./baseline-checks.js";

const pexec = promisify(execFile);
type Line = z.input<typeof HealthViewSchema>["lines"][number];

export interface HealthDeps {
  db: PrismaClient;
  repoPath: string;
  baseRef: string;
  workspacesRoot: string;
  claudeBinary: string;
  baseline: BaselineChecks;
}

const ok = (label: string, value: string): Line => ({ label, value, ok: true, problem: null });

export async function healthLines(d: HealthDeps): Promise<HealthView> {
  const lines: Line[] = [];

  try {
    const rows = await d.db.$queryRawUnsafe<Array<{ server_version: string }>>("SHOW server_version");
    lines.push(ok("Database", `PostgreSQL ${rows[0]?.server_version.split(" ")[0] ?? ""}`.trim()));
  } catch (e) {
    lines.push({
      label: "Database",
      value: "not reachable",
      ok: false,
      problem: { title: "Nothing can be recorded: the database is not reachable", explain: String(e).slice(0, 200), command: "pnpm console" },
    });
  }

  try {
    const branch = (await pexec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d.repoPath })).stdout.trim();
    const sha = (await pexec("git", ["rev-parse", "--short=7", "HEAD"], { cwd: d.repoPath })).stdout.trim();
    lines.push(ok("Your repo", `${d.repoPath.replace(/^\/Users\/[^/]+/, "~")} · on ${branch} at ${sha}`));
  } catch {
    lines.push({
      label: "Your repo",
      value: `not a git repository · ${d.repoPath}`,
      ok: false,
      problem: { title: "Nothing can start: the repo is not a git repository", explain: "Signet works in its own copy of a git repository, branched from your main branch.", command: null },
    });
  }

  try {
    const v = (await pexec(d.claudeBinary, ["--version"], { timeout: 15_000 })).stdout.trim().split(" ")[0] ?? "";
    // Installed is not signed in. This line said "your subscription login" on a machine
    // that had never signed in, and the first ask then failed. `claude auth status`
    // answers without spending tokens; a version without it keeps the old answer.
    const signedIn = await pexec(d.claudeBinary, ["auth", "status"], { timeout: 15_000 }).then(
      (r) => readSignedIn(r.stdout),
      (e: { stdout?: string }) => readSignedIn(e.stdout ?? ""),
    );
    if (signedIn === false) {
      lines.push({
        label: "Claude Code",
        value: `${v} · not signed in`,
        ok: false,
        problem: {
          title: "Nothing can be built: Claude Code is not signed in",
          explain: "Signet drives your own Claude Code with your subscription. Run claude in a terminal, sign in once, and come back.",
          command: "claude",
        },
      });
    } else {
      lines.push(ok("Claude Code", `${v} · your subscription login`));
    }
  } catch {
    lines.push({
      label: "Claude Code",
      value: `not found · ${d.claudeBinary}`,
      ok: false,
      problem: { title: "Nothing can be built: Claude Code is not installed here", explain: "Signet drives your own Claude Code with your subscription. Install it and sign in once.", command: "npm install -g @anthropic-ai/claude-code" },
    });
  }

  try {
    await mkdir(d.workspacesRoot, { recursive: true });
    await access(d.workspacesRoot, constants.W_OK);
    lines.push(ok("Workspaces folder", `writable · ${d.workspacesRoot.replace(/^\/Users\/[^/]+/, "~")}`));
  } catch {
    const path = d.workspacesRoot.replace(/^\/Users\/[^/]+/, "~");
    lines.push({
      label: "Workspaces folder",
      value: `not writable · ${path}`,
      ok: false,
      problem: {
        title: "Nothing can start: the workspaces folder is not writable",
        explain: "Signet makes its own copy of your repo there for every step. Fix the folder; everything already on main is unaffected.",
        command: `chmod u+w ${path}`,
      },
    });
  }

  const report = await d.baseline.last(d.repoPath);
  if (!report) {
    lines.push(ok("Checks on main", "not checked yet — they run each morning"));
  } else {
    const bad = report.checks.filter((c) => c.outcome === "fail" || c.outcome === "cannot_run");
    const at = new Date(report.checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
    const ran = report.checks.filter((c) => c.outcome === "pass").map((c) => (c.check === "typecheck" ? "types" : c.check));
    if (bad.length === 0) {
      const list = ran.length <= 1 ? ran.join("") : `${ran.slice(0, -1).join(", ")} and ${ran.at(-1)}`;
      lines.push(ok("Checks on main", `${ran.length > 0 ? `${list} ${ran.length === 1 ? "pass" : "all pass"}` : "nothing to check"} on ${report.ref} as of ${at}`));
    } else {
      const first = bad[0];
      lines.push({
        label: "Checks on main",
        value: `${bad.map((c) => (c.check === "typecheck" ? "types" : c.check)).join(", ")} ${first?.outcome === "cannot_run" ? "cannot run" : "failing"} on ${report.ref} as of ${at}`,
        ok: false,
        problem: {
          title: first?.outcome === "cannot_run" ? `Every step would fail: ${first.check} cannot run here` : `Every step inherits a failing ${first?.check ?? "check"}`,
          explain: first?.detail ?? "",
          command: first?.command ?? null,
        },
      });
    }
  }

  return HealthViewSchema.parse({ lines });
}

/** `claude auth status` prints JSON with `loggedIn`; anything else means we cannot tell. */
function readSignedIn(stdout: string): boolean | null {
  try {
    const v = (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn; // signet-policy-allow: raw-json-parse -- one boolean from claude's own status output
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}
