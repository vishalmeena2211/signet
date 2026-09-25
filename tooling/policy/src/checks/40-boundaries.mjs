// Check: one-way layering in apps/core — http → services → domain → persistence.
// Runs dependency-cruiser with the config at tooling/policy/dep-cruiser.config.mjs.
// Also enforces: adapter never imports persistence; domain never imports http.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../lib.mjs";

export default {
  name: "boundaries: one-way layering in apps/core (dependency-cruiser)",
  async run() {
    const coreSrc = join(repoRoot, "apps", "core", "src");
    const config = join(repoRoot, "tooling", "policy", "dep-cruiser.config.mjs");
    const bin = join(repoRoot, "tooling", "policy", "node_modules", ".bin", "depcruise");

    const result = await new Promise((resolve) => {
      const child = spawn(bin, ["--config", config, coreSrc], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code: code ?? 1, out }));
      child.on("error", (err) => resolve({ code: 1, out: String(err) }));
    });

    if (result.code === 0) return { ok: true, violations: [] };
    const violations = result.out
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(0, 30);
    return { ok: false, violations };
  },
};
