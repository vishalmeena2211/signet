// What the adapter hands Claude Code, pinned with a stand-in binary that records its
// arguments: no model call, no quota.

import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "./claude-adapter.js";
import type { Logger } from "../runtime/logger.js";

const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => nullLogger };

async function fakeClaude(): Promise<{ bin: string; argsFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "signet-fake-claude-"));
  const argsFile = join(dir, "args.json");
  const bin = join(dir, "claude");
  await writeFile(
    bin,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n` +
      `console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", usage: {} }));\n`,
  );
  await chmod(bin, 0o755);
  return { bin, argsFile };
}

describe("reading a repo without being able to change it", () => {
  it("gives a read-only run the repo with --add-dir, and only Read, Glob and Grep", async () => {
    const { bin, argsFile } = await fakeClaude();
    const scratch = await mkdtemp(join(tmpdir(), "signet-scratch-"));
    const repo = await mkdtemp(join(tmpdir(), "signet-repo-"));
    await new ClaudeAdapter({ binary: bin, timeoutMs: 20_000 }, nullLogger).execute({
      workspacePath: scratch,
      prompt: "plan",
      readOnlyDirs: [repo],
      onEvent: async () => {},
    });
    const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    expect(args[args.indexOf("--add-dir") + 1]).toBe(repo);
    const settings = JSON.parse(await readFile(join(scratch, ".claude", "settings.json"), "utf8")) as { permissions: { allow: string[]; deny: string[] } };
    expect(settings.permissions.allow).toEqual(["Read", "Glob", "Grep"]);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Edit", "Write", "Bash", `Read(${join(repo, "**/.env*")})`]));
  });

  it("lets a writing run use each ecosystem's own test command", async () => {
    const { bin } = await fakeClaude();
    const ws = await mkdtemp(join(tmpdir(), "signet-ws-"));
    await new ClaudeAdapter({ binary: bin, timeoutMs: 20_000 }, nullLogger).execute({ workspacePath: ws, prompt: "write", onEvent: async () => {} });
    const settings = JSON.parse(await readFile(join(ws, ".claude", "settings.json"), "utf8")) as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(["Edit", "Bash(npm test:*)", "Bash(go test:*)", "Bash(cargo test:*)", "Bash(python3 -m pytest:*)"]));
  });
});
