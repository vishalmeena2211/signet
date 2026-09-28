// "Watch it work": the stream's tool calls, turned into actions a person recognises,
// kept per run, and drawn as a map of where the agent has been.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseStreamLine } from "../domain/adapter/stream-parser.js";
import { AgentWorkLog, buildWorkView, toAgentAction } from "./agent-work.js";

const exec = promisify(execFile);
const NOW = new Date("2026-09-28T15:05:12.000Z");

function toolLine(name: string, input: unknown): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
}

describe("the stream keeps what a person would want to see", () => {
  it("keeps a Write's path even when its content blows past the preview", () => {
    // The path used to be recoverable only from a 2000-char preview, and a Write's
    // input is mostly file content — so the path could be cut off entirely.
    const [ev] = parseStreamLine(toolLine("Write", { content: "x".repeat(5000), file_path: "/ws/src/cluster.ts" }), NOW);
    expect(ev).toMatchObject({ type: "tool_use", toolName: "Write", detail: { filePath: "/ws/src/cluster.ts" } });
  });

  it("keeps the agent's own to-do list", () => {
    const [ev] = parseStreamLine(
      toolLine("TodoWrite", {
        todos: [
          { content: "Find where markers are drawn", status: "completed", activeForm: "Finding where markers are drawn" },
          { content: "Make it pass", status: "in_progress", activeForm: "Making it pass" },
          { content: "not a todo" },
        ],
      }),
      NOW,
    );
    expect(ev?.type === "tool_use" && ev.detail?.todos).toEqual([
      { content: "Find where markers are drawn", status: "completed", activeForm: "Finding where markers are drawn" },
      { content: "Make it pass", status: "in_progress", activeForm: "Making it pass" },
    ]);
  });

  it("keeps a command and its stated reason", () => {
    const [ev] = parseStreamLine(toolLine("Bash", { command: "pnpm vitest run src/layer.test.ts", description: "Run the layer tests" }), NOW);
    expect(ev).toMatchObject({ detail: { command: "pnpm vitest run src/layer.test.ts", description: "Run the layer tests" } });
  });

  it("yields no detail for a tool it has never heard of, and still yields the event", () => {
    const [ev] = parseStreamLine(toolLine("SomethingNew", { weird: 1 }), NOW);
    expect(ev).toMatchObject({ type: "tool_use", toolName: "SomethingNew" });
    expect(ev?.type === "tool_use" && ev.detail).toBeFalsy();
  });
});

describe("toAgentAction", () => {
  const ws = "/tmp/ws/inc-1";
  const tool = (toolName: string, detail: Record<string, unknown>) =>
    ({ type: "tool_use", toolName, inputPreview: "", detail }) as const;

  it("names files relative to the repo", () => {
    expect(toAgentAction(tool("Read", { filePath: `${ws}/src/spatial.ts` }), "plan", ws, NOW)).toMatchObject({
      kind: "read",
      path: "src/spatial.ts",
      phase: "plan",
    });
    expect(toAgentAction(tool("MultiEdit", { filePath: `${ws}/src/layer.ts` }), "implement", ws, NOW)).toMatchObject({
      kind: "edit",
      path: "src/layer.ts",
    });
  });

  it("keeps a path outside the workspace absolute, because that is worth noticing", () => {
    expect(toAgentAction(tool("Read", { filePath: "/etc/hosts" }), "plan", ws, NOW)?.path).toBe("/etc/hosts");
  });

  it("ignores events that are not tool calls", () => {
    expect(toAgentAction({ type: "assistant_text", text: "hi" }, "plan", ws, NOW)).toBeNull();
  });
});

describe("the log and the map", () => {
  let root: string;
  let repo: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "signet-work-"));
    repo = join(root, "repo");
    await mkdir(join(repo, "src", "render"), { recursive: true });
    for (const [f, body] of [
      ["src/layer.ts", "x".repeat(210)],
      ["src/layer.test.ts", "t"],
      ["src/spatial.ts", "s".repeat(180)],
      ["src/tiles.ts", "t".repeat(240)],
      ["src/render/webgl.ts", "w"],
      ["README.md", "r"],
    ] as const) {
      await writeFile(join(repo, f), body);
    }
    await exec("git", ["init", "-q"], { cwd: repo });
    await exec("git", ["add", "-A"], { cwd: repo });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("appends and reads back, skipping a torn last line", async () => {
    const log = new AgentWorkLog(join(root, "packs"));
    await log.append("r1", { at: NOW.toISOString(), kind: "read", path: "src/a.ts", phase: "plan" });
    await appendFile(join(root, "packs", "run-r1", "activity.jsonl"), '{"at":"2026-');
    expect(await log.read("r1")).toHaveLength(1);
    expect(await log.read("never-ran")).toEqual([]);
  });

  it("maps the neighbourhood it worked in: read, changed, fenced, reached", async () => {
    const at = NOW.toISOString();
    const view = await buildWorkView({
      runId: "00000000-0000-4000-8000-00000000bbbb",
      actions: [
        { at, kind: "todos", phase: "implement", todos: [{ content: "Make it pass", status: "in_progress" }] },
        { at, kind: "read", path: "src/spatial.ts", phase: "plan" },
        { at, kind: "edit", path: "src/layer.ts", phase: "implement" },
        { at, kind: "edit", path: "src/cluster.ts", phase: "implement" }, // new, not yet tracked
      ],
      surface: ["src/layer.ts", "src/layer.test.ts", "src/cluster.ts"],
      workspacePath: repo,
      reached: ["src/tiles.ts"],
    });
    expect(view.todos).toEqual([{ content: "Make it pass", status: "in_progress" }]);
    expect(view.actions.map((a) => a.kind)).toEqual(["read", "edit", "edit"]);
    const byPath = new Map(view.files.map((f) => [f.path, f]));
    expect(byPath.get("src/layer.ts")).toMatchObject({ changed: true, fenced: true, bytes: 210 });
    expect(byPath.get("src/spatial.ts")).toMatchObject({ read: true, fenced: false });
    expect(byPath.get("src/tiles.ts")).toMatchObject({ reached: true, fenced: false });
    expect(byPath.get("src/cluster.ts")).toMatchObject({ changed: true });
    // Outside the directories it worked in: not drawn.
    expect(byPath.has("src/render/webgl.ts")).toBe(false);
    expect(byPath.has("README.md")).toBe(false);
  });
});
