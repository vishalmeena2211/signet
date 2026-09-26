// The Claude Code adapter: spawns the user's own `claude` installation
// headless and streams parsed AdapterEvents. Subscription auth only — no API
// keys anywhere. Permission posture: NEVER --dangerously-skip-permissions;
// a per-run settings file allows edits inside the workspace only.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AdapterAvailabilitySchema,
  nonRecoverable,
  recoverable,
  type AdapterAvailability,
  type AdapterEvent,
  type ModelUsage,
  type SessionRef,
  type SignetError,
} from "@signet/contracts";
import type { Logger } from "../runtime/logger.js";
import { parseStreamLine } from "./stream-parser.js";

const pexec = promisify(execFile);

export interface ClaudeAdapterOptions {
  binary: string; // "claude" or absolute path
  timeoutMs: number; // per-invocation wall clock cap
}

export interface ExecuteInput {
  workspacePath: string;
  prompt: string;
  appendSystemPromptFile?: string;
  resumeSession?: SessionRef | null;
  maxTurns?: number;
  model?: string; // e.g. tiny tasks pin claude-haiku-4-5 to spare the quota window
  signal?: AbortSignal; // user abort — SIGTERM the worker, classify as aborted
  onEvent: (ev: AdapterEvent) => Promise<void>;
}

export interface ExecuteResult {
  ok: boolean;
  sessionRef: SessionRef | null;
  resultText: string;
  usage: ModelUsage[];
  error: SignetError | null;
}

export class ClaudeAdapter {
  constructor(
    private readonly opts: ClaudeAdapterOptions,
    private readonly log: Logger,
  ) {}

  /** Detect installation + auth without spending tokens. */
  async probe(): Promise<AdapterAvailability> {
    const problems: string[] = [];
    let version: string | undefined;
    let binaryPath: string | undefined;
    try {
      const { stdout } = await pexec(this.opts.binary, ["--version"], { timeout: 15_000 });
      version = stdout.trim().split(" ")[0];
    } catch {
      problems.push(`claude binary not runnable: ${this.opts.binary}`);
    }
    try {
      const { stdout } = await pexec("which", [this.opts.binary], { timeout: 5_000 });
      binaryPath = stdout.trim();
    } catch {
      /* non-fatal */
    }
    // Auth check: `claude auth status` isn't universal across versions; treat
    // a working --version as installed and let the first run surface auth
    // problems as typed failed events rather than guessing here.
    const authenticated = problems.length === 0;
    return AdapterAvailabilitySchema.parse({
      installed: version !== undefined,
      ...(version !== undefined ? { version } : {}),
      authenticated,
      ...(binaryPath !== undefined ? { binaryPath } : {}),
      problems,
    });
  }

  /**
   * Write the per-run permission profile: edits allowed inside the workspace,
   * everything else default-deny (prompts would block a headless run, so
   * denied means the model must work within its sandbox).
   */
  private async writePermissionProfile(workspacePath: string): Promise<string> {
    const dir = join(workspacePath, ".claude");
    await mkdir(dir, { recursive: true });
    const settings = {
      permissions: {
        allow: [
          "Read",
          "Edit",
          "Write",
          "Glob",
          "Grep",
          `Bash(cd:*)`,
          `Bash(ls:*)`,
          `Bash(cat:*)`,
          `Bash(node:*)`,
          `Bash(pnpm test:*)`,
          `Bash(pnpm run test:*)`,
          `Bash(git status:*)`,
          `Bash(git diff:*)`,
          `Bash(git log:*)`,
        ],
        deny: ["WebFetch", "WebSearch", `Read(${join(workspacePath, ".env")})`, `Read(**/.env*)`],
      },
    };
    const file = join(dir, "settings.json");
    await writeFile(file, JSON.stringify(settings, null, 2), "utf8");
    return file;
  }

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    await this.writePermissionProfile(input.workspacePath);

    const args = ["--print", "--output-format", "stream-json", "--verbose"];
    if (input.resumeSession) args.push("--resume", input.resumeSession);
    if (input.maxTurns !== undefined) args.push("--max-turns", String(input.maxTurns));
    if (input.model !== undefined) args.push("--model", input.model);
    if (input.appendSystemPromptFile) args.push("--append-system-prompt-file", input.appendSystemPromptFile);

    const log = this.log.child({});
    log.info("adapter.spawn", { args: args.join(" ") });

    return new Promise<ExecuteResult>((resolve) => {
      const child = spawn(this.opts.binary, args, {
        cwd: input.workspacePath,
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "signet" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let sessionRef: SessionRef | null = input.resumeSession ?? null;
      let resultText = "";
      const usage: ModelUsage[] = [];
      let terminalError: SignetError | null = null;
      let sawCompleted = false;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          terminalError = recoverable("adapter.timeout", `no completion within ${this.opts.timeoutMs}ms`);
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
        }
      }, this.opts.timeoutMs);
      timer.unref();

      const onAbort = () => {
        if (!settled) {
          terminalError = nonRecoverable("adapter.aborted", "aborted by user");
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
        }
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });

      const handleEvent = async (ev: AdapterEvent) => {
        switch (ev.type) {
          case "session_started":
            sessionRef = ev.sessionRef;
            break;
          case "completed":
            sawCompleted = true;
            sessionRef = ev.sessionRef;
            resultText = ev.resultText;
            usage.push(...ev.perModel);
            break;
          case "usage_update":
            usage.push(...ev.perModel);
            break;
          case "limit_reached":
            terminalError = recoverable("adapter.limit_reached", ev.rawMessage);
            break;
          case "refusal":
            terminalError = nonRecoverable("adapter.refusal", ev.rawMessage);
            break;
          case "failed":
            terminalError = { kind: ev.errorKind, code: ev.errorCode, message: ev.rawMessage };
            break;
          default:
            break;
        }
        await input.onEvent(ev);
      };

      const stdout = createInterface({ input: child.stdout });
      const stderr = createInterface({ input: child.stderr });
      const pending: Promise<void>[] = [];

      stdout.on("line", (line) => {
        for (const ev of parseStreamLine(line, new Date())) {
          pending.push(handleEvent(ev).catch(() => {}));
        }
      });
      stderr.on("line", (line) => {
        // Limit banners sometimes arrive on stderr as plain text.
        for (const ev of parseStreamLine(line, new Date())) {
          if (ev.type === "limit_reached") pending.push(handleEvent(ev).catch(() => {}));
        }
      });

      child.on("error", (err) => {
        terminalError = nonRecoverable("adapter.spawn_failed", String(err));
      });

      child.on("close", (code) => {
        void (async () => {
          await Promise.all(pending);
          clearTimeout(timer);
          settled = true;
          if (terminalError && terminalError.code !== "adapter.timeout" && !sawCompleted) {
            resolve({ ok: false, sessionRef, resultText, usage, error: terminalError });
            return;
          }
          if (terminalError?.code === "adapter.limit_reached") {
            resolve({ ok: false, sessionRef, resultText, usage, error: terminalError });
            return;
          }
          if (!sawCompleted) {
            resolve({
              ok: false,
              sessionRef,
              resultText,
              usage,
              error:
                terminalError ??
                recoverable("adapter.no_result", `process exited ${code} without a result event`),
            });
            return;
          }
          resolve({ ok: true, sessionRef, resultText, usage, error: null });
        })();
      });

      // The prompt goes on stdin (avoids argv length limits and shell quoting).
      child.stdin.write(input.prompt);
      child.stdin.end();
    });
  }
}

/** Parse a JSON plan out of an agent's result text (fenced or bare). */
export function extractJsonBlock(text: string): object | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)); // signet-policy-allow: raw-json-parse -- callers validate through contracts schemas immediately
  } catch {
    return null;
  }
}
