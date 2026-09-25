import { describe, expect, it } from "vitest";
import {
  ALLOWED_INCREMENT_TRANSITIONS,
  ALLOWED_RULE_TRANSITIONS,
  IncrementStateSchema,
  RUN_PHASE_ORDER,
  RunPhaseNameSchema,
} from "./states.js";
import { parseConfig } from "./config.js";
import { AdapterEventSchema } from "./adapter.js";

describe("increment state machine", () => {
  it("MERGED is terminal; FAILED is revivable only to CONTEXT_READY (human retry)", () => {
    expect(ALLOWED_INCREMENT_TRANSITIONS.MERGED).toHaveLength(0);
    expect(ALLOWED_INCREMENT_TRANSITIONS.FAILED).toEqual(["CONTEXT_READY"]);
  });

  it("every transition target is a defined state", () => {
    const states = Object.keys(ALLOWED_INCREMENT_TRANSITIONS);
    for (const targets of Object.values(ALLOWED_INCREMENT_TRANSITIONS)) {
      for (const t of targets) expect(states).toContain(t);
    }
  });

  it("repair loop exists: VERIFYING can return to RUNNING", () => {
    expect(ALLOWED_INCREMENT_TRANSITIONS.VERIFYING).toContain("RUNNING");
  });

  it("parses a PARKED state with resume time", () => {
    const parked = IncrementStateSchema.safeParse({
      status: "PARKED",
      quotaWindowId: "d3b07384-d9a0-4c9a-8b3e-111111111111",
      resumeAt: new Date().toISOString(),
    });
    expect(parked.success).toBe(true);
  });
});

describe("run phases", () => {
  it("phase order covers every declared phase exactly once", () => {
    const declared = RunPhaseNameSchema.options;
    expect([...RUN_PHASE_ORDER].sort()).toEqual([...declared].sort());
    expect(new Set(RUN_PHASE_ORDER).size).toBe(RUN_PHASE_ORDER.length);
  });
});

describe("rule lifecycle", () => {
  it("rejected/retired/superseded are terminal", () => {
    expect(ALLOWED_RULE_TRANSITIONS.REJECTED).toHaveLength(0);
    expect(ALLOWED_RULE_TRANSITIONS.RETIRED).toHaveLength(0);
    expect(ALLOWED_RULE_TRANSITIONS.SUPERSEDED).toHaveLength(0);
  });
  it("demotion is reversible only through re-confirmation", () => {
    expect(ALLOWED_RULE_TRANSITIONS.DEMOTED).toContain("CONFIRMED");
  });
});

describe("config", () => {
  it("refuses to start on missing databaseUrl with a readable report", () => {
    expect(() => parseConfig({ SIGNET_WORKSPACES_ROOT: "/tmp/ws" })).toThrow(/refusing to start/);
  });
  it("applies safe defaults: loopback host, 2 workers, 3 repairs, main base", () => {
    const cfg = parseConfig({
      SIGNET_DATABASE_URL: "postgres://localhost/signet",
      SIGNET_WORKSPACES_ROOT: "/tmp/ws",
      SIGNET_TARGET_REPO_PATH: "/tmp/repo",
      SIGNET_PACKS_ROOT: "/tmp/packs",
    });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.maxConcurrentWorkers).toBe(2);
    expect(cfg.maxRepairIterations).toBe(3);
    expect(cfg.baseRef).toBe("main");
  });
});

describe("adapter events", () => {
  it("parses a limit_reached event", () => {
    const ev = AdapterEventSchema.safeParse({
      type: "limit_reached",
      limitKind: "five_hour",
      resetsAt: new Date().toISOString(),
      rawMessage: "5-hour limit reached ∙ resets 7:40pm",
    });
    expect(ev.success).toBe(true);
  });
  it("rejects a malformed usage_update instead of letting it through", () => {
    const ev = AdapterEventSchema.safeParse({ type: "usage_update", perModel: [] });
    expect(ev.success).toBe(false);
  });
});
