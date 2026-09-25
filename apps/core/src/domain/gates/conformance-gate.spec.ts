// The conformance gate against a REAL git worktree and a REAL diff — proving
// the detection half of the wedge: when a build diverges from the approved
// design, the gate fails with per-dimension, file:line-specific findings that
// become the agent's repair feedback.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IncrementIdSchema, RunIdSchema, type DesignOfRecord } from "@signet/contracts";
import { conformanceGate } from "./conformance-gate.js";

const pexec = promisify(execFile);
const INC = IncrementIdSchema.parse("11111111-aaaa-4bbb-8ccc-00000000cf01");
const RUN = RunIdSchema.parse("22222222-aaaa-4bbb-8ccc-00000000cf02");

let repo: string;

async function git(args: string[]) {
  await pexec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
}

const design: DesignOfRecord = {
  incrementId: INC,
  source: "resolved",
  approvedBy: "vishal",
  approvedAt: new Date().toISOString(),
  intent: {
    palette: ["#6609be"],
    maxDeltaE: 8,
    forbiddenColors: [],
    requiredAssets: [],
    forbiddenAssets: ["public/logo/logo.svg"],
  },
};

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "signet-confgate-"));
  await git(["init", "-b", "main"]);
  await writeFile(join(repo, "app.mjs"), `export const app = () => "base";\n`);
  await git(["add", "-A"]);
  await git(["commit", "-m", "base"]);
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("conformance gate — live against a real diff", () => {
  it("passes when the change stays inside the approved palette", async () => {
    await writeFile(join(repo, "ok.mjs"), `export const c = "#6609be";\n`);
    await git(["add", "-A"]);
    await git(["commit", "-m", "on-brand change"]);

    const gate = conformanceGate({ loadDesign: async () => design });
    const v = await gate.run({
      workspacePath: repo,
      baseRef: "main~1",
      changedFiles: ["ok.mjs"],
      runId: RUN,
      incrementId: INC,
    });
    expect(v.outcome).toBe("pass");
  });

  it("THE WEDGE, DETECTION HALF: fails a divergent build with file:line findings", async () => {
    await writeFile(
      join(repo, "promo.mjs"),
      `export const banner = () => ({ background: "#ff5722" });\nexport const logo = "/logo/logo.svg";\n`,
    );
    await git(["add", "-A"]);
    await git(["commit", "-m", "off-brand change"]);

    const gate = conformanceGate({ loadDesign: async () => design });
    const v = await gate.run({
      workspacePath: repo,
      baseRef: "main~1",
      changedFiles: ["promo.mjs"],
      runId: RUN,
      incrementId: INC,
    });

    expect(v.outcome).toBe("fail"); // blocks — the design was signed by a human
    const dims = v.findings.map((f) => f.dimension);
    expect(dims).toContain("palette");
    expect(dims).toContain("forbidden_asset");
    // the finding is specific enough to act on — this text becomes repair feedback
    const paletteFinding = v.findings.find((f) => f.dimension === "palette");
    expect(paletteFinding?.message).toContain("promo.mjs:1");
    expect(paletteFinding?.message).toMatch(/ΔE \d+/);
  });

  it("skips cleanly when an increment has no approved design (not every increment is visual)", async () => {
    const gate = conformanceGate({ loadDesign: async () => null });
    const v = await gate.run({
      workspacePath: repo,
      baseRef: "main~1",
      changedFiles: [],
      runId: RUN,
      incrementId: INC,
    });
    expect(v.outcome).toBe("skipped");
  });
});
