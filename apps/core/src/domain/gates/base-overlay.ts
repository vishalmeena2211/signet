// runOnBase implementation: materialize the BASE ref in a temp dir (the gate
// sandbox — the agent's worktree is never executed for this), overlay the
// agent's test files onto it, run the command, clean up. This is the
// falsifiability check's isolation boundary.

import { mkdtemp, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCommand } from "./gate-runner.js";
import type { TestsGateDeps } from "./standard-gates.js";

const pexec = promisify(execFile);

export function makeRunOnBase(): TestsGateDeps["runOnBase"] {
  return async ({ workspacePath, baseRef, overlayFiles, cmd, args }) => {
    const sandbox = await mkdtemp(join(tmpdir(), "signet-base-"));
    try {
      // Export the base tree without touching the worktree's checkout:
      // git archive from the worktree's repo reads the ref's objects directly.
      const tar = join(sandbox, "base.tar");
      await pexec("git", ["archive", "--format=tar", "-o", tar, baseRef], { cwd: workspacePath });
      await pexec("tar", ["-xf", tar, "-C", sandbox], {});
      await rm(tar, { force: true });

      for (const rel of overlayFiles) {
        const dest = join(sandbox, rel);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(join(workspacePath, rel), dest);
      }

      // Dependencies: reuse the workspace's node_modules via symlink — the
      // base ref and the change share deps in Phase 0 scope.
      try {
        await pexec("ln", ["-s", join(workspacePath, "node_modules"), join(sandbox, "node_modules")], {});
      } catch {
        /* no node_modules — fine for dep-free fixtures */
      }

      return await runCommand(cmd, args, sandbox, 120_000);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  };
}
