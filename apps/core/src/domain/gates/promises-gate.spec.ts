// The promises gate against a real git repo: the agent's closing message on one side,
// the actual change on the other.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RunIdSchema } from "@signet/contracts";
import { PROOFS_FILE, promisesGate } from "./promises-gate.js";

const exec = promisify(execFile);
const RUN = RunIdSchema.parse("00000000-0000-4000-8000-00000000aaaa");

describe("promises gate", () => {
  let root: string;
  let ws: string;
  let packs: string;
  const git = (...args: string[]) =>
    exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: ws });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "signet-promises-"));
    ws = join(root, "ws");
    packs = join(root, "packs");
    await mkdir(join(ws, "src"), { recursive: true });
    await mkdir(join(packs, `run-${RUN}`), { recursive: true });
    await writeFile(join(ws, "src", "cart.ts"), "export const total = (x: number) => x;\n");
    await git("init", "-q", "-b", "main");
    await git("add", "-A");
    await git("commit", "-q", "-m", "base");
    await git("checkout", "-q", "-b", "work");
    await writeFile(join(ws, "src", "cart.ts"), "export const total = (x: number, pct = 0) => x * (1 - pct / 100);\n");
    await writeFile(join(ws, "src", "cart.test.ts"), 'it("applies a 10% discount", () => {});\n');
    await git("add", "-A");
    await git("commit", "-q", "-m", "work");
    await writeFile(
      join(packs, `run-${RUN}`, "acceptance.md"),
      "- A 10% discount on 100 totals 90\n- A discount above 100% is rejected\n",
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = () =>
    promisesGate({ packsRoot: packs }).run({ workspacePath: ws, baseRef: "main", changedFiles: [], runId: RUN });

  it("warns — never fails — when one promise has no test, and says which", async () => {
    await writeFile(
      join(packs, `run-${RUN}`, PROOFS_FILE),
      'Done.\n```json\n{"proofs":[{"promise":1,"test":"applies a 10% discount","testFile":"src/cart.test.ts","codeFile":"src/cart.ts","codeLines":"1"},{"promise":2,"test":null}]}\n```',
    );
    const v = await run();
    expect(v.outcome).toBe("warn");
    expect(v.findings.map((f) => [f.dimension, f.message])).toEqual([
      ["proven", "A 10% discount on 100 totals 90"],
      ["unproven", "A discount above 100% is rejected"],
    ]);
    expect(v.findings[0]?.proof).toEqual({ test: "applies a 10% discount", testFile: "src/cart.test.ts", codeFile: "src/cart.ts", codeLines: "1" });
  });

  it("reports every promise unproven when the agent made no claim at all", async () => {
    const v = await run();
    expect(v.outcome).toBe("warn");
    expect(v.findings.every((f) => f.dimension === "unproven")).toBe(true);
  });

  it("skips a step whose done-when is empty", async () => {
    await writeFile(join(packs, `run-${RUN}`, "acceptance.md"), "");
    expect((await run()).outcome).toBe("skipped");
  });
});
