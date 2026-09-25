// LIVE adapter smoke test — spawns the user's real Claude Code once, with a
// haiku-sized task, in a throwaway workspace. Burns a tiny amount of the
// subscription window; guarded so ordinary test runs never trigger it:
//   SIGNET_LIVE_ADAPTER=1 vitest run src/domain/adapter/claude-adapter.live.spec.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent } from "@signet/contracts";
import type { Logger } from "../runtime/logger.js";
import { ClaudeAdapter } from "./claude-adapter.js";

const enabled = process.env["SIGNET_LIVE_ADAPTER"] === "1";
const d = enabled ? describe : describe.skip;

const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};

let workspace: string;

beforeAll(async () => {
  if (!enabled) return;
  workspace = await mkdtemp(join(tmpdir(), "signet-live-"));
});

afterAll(async () => {
  if (!enabled) return;
  await rm(workspace, { recursive: true, force: true });
});

d("claude adapter (LIVE — burns quota)", () => {
  it("probe finds the local installation", async () => {
    const adapter = new ClaudeAdapter({ binary: "claude", timeoutMs: 120_000 }, nullLogger);
    const avail = await adapter.probe();
    expect(avail.installed).toBe(true);
    expect(avail.version).toBeTruthy();
  });

  it(
    "executes a tiny task: session captured, per-model usage recorded, file written",
    { timeout: 300_000 },
    async () => {
      const adapter = new ClaudeAdapter({ binary: "claude", timeoutMs: 240_000 }, nullLogger);
      const events: AdapterEvent[] = [];
      const result = await adapter.execute({
        workspacePath: workspace,
        prompt:
          "Create a file named hello.txt in the current directory containing exactly the text: hello signet\n" +
          "Do nothing else. Do not explain.",
        maxTurns: 6,
        model: "claude-haiku-4-5",
        onEvent: async (ev) => {
          events.push(ev);
        },
      });

      expect(result.ok).toBe(true);
      expect(result.sessionRef).toBeTruthy();
      expect(result.usage.length).toBeGreaterThan(0);
      const totalOut = result.usage.reduce((s, u) => s + u.outputTokens, 0);
      expect(totalOut).toBeGreaterThan(0);

      const written = await readFile(join(workspace, "hello.txt"), "utf8");
      expect(written.trim()).toBe("hello signet");

      // The stream produced real telemetry we can journal.
      expect(events.some((e) => e.type === "session_started")).toBe(true);
      expect(events.some((e) => e.type === "completed")).toBe(true);
    },
  );
});
