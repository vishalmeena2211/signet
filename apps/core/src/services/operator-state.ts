// Operator decisions that must outlive the process.
//
// If someone pauses the dispatcher and the box reboots, work must NOT quietly
// start flowing again — the pause was a decision, and losing it on restart is
// the kind of surprise that costs quota or lands half-reviewed branches. So it
// is written down.
//
// A small JSON file rather than a table: this is instance-local operator state,
// not domain data, and it deliberately avoids a schema migration for one flag.
// Reads tolerate a missing or corrupt file by falling back to defaults, because
// refusing to boot over an unreadable preferences file would be worse than
// resuming with the documented default.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Logger } from "../domain/runtime/logger.js";

const OperatorStateSchema = z.object({
  paused: z.boolean().default(false),
  maxWorkers: z.number().int().min(1).max(16).optional(),
});
export type OperatorState = z.infer<typeof OperatorStateSchema>;

export class OperatorStateStore {
  constructor(
    private readonly path: string,
    private readonly log: Logger,
  ) {}

  async load(): Promise<OperatorState> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = OperatorStateSchema.safeParse(JSON.parse(raw)); // signet-policy-allow: raw-json-parse -- immediately schema-validated
      if (parsed.success) return parsed.data;
      this.log.warn("operator_state.invalid", { path: this.path, issues: parsed.error.issues.length });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // A first boot has no file; anything else is worth a line in the log.
      if (code !== "ENOENT") this.log.warn("operator_state.unreadable", { path: this.path, code });
    }
    return { paused: false };
  }

  async save(state: OperatorState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(state, null, 2), "utf8");
  }
}
