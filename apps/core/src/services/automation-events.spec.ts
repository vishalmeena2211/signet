// The event bus, pinned.
//
// This exists to break a dependency cycle, so it is almost nothing — which is the point.
// Two properties are load-bearing and both are about NOT causing harm:
//
//   · Publishing never throws. The publisher has already done its work: a merge has
//     happened, a run has failed, rules have been written. If a workflow triggered by
//     that then errors, the original action must not be reported as failed. This is the
//     difference between "a merge landed and an automation misfired" and "a merge that
//     landed looks like it did not".
//   · With no subscriber it is a no-op, so the real services can be constructed in tests
//     and in any future headless mode without automation attached.

import { describe, expect, it, vi } from "vitest";
import { AutomationEvents } from "./automation-events.js";

import type { Logger } from "../domain/runtime/logger.js";

/** A real Logger shape rather than a cast, so the spy below can be typed. */
function makeLogger(error: Logger["error"] = () => {}): Logger {
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error,
    child: () => log,
  };
  return log;
}

describe("publishing cannot break the publisher", () => {
  it("swallows a subscriber that throws", async () => {
    // The scenario: a step merged, and a workflow listening for step_merged blows up.
    // The merge is already committed. Rethrowing here would surface a git operation that
    // succeeded as one that failed.
    const events = new AutomationEvents(makeLogger());
    events.subscribe(async () => {
      throw new Error("workflow exploded");
    });
    await expect(events.publish("step_merged")).resolves.toBeUndefined();
  });

  it("logs the failure rather than losing it", async () => {
    const error = vi.fn();
    const events = new AutomationEvents(makeLogger(error));
    events.subscribe(async () => {
      throw new Error("workflow exploded");
    });
    await events.publish("run_failed");
    // Swallowed is not the same as silent: a misfiring automation has to be findable.
    expect(error).toHaveBeenCalled();
  });
});

describe("with nobody listening", () => {
  it("does nothing, so services work without automation attached", async () => {
    const events = new AutomationEvents(makeLogger());
    await expect(events.publish("rules_proposed")).resolves.toBeUndefined();
  });
});

describe("what it passes along", () => {
  it("carries the cause, so a workflow can ignore its own output", async () => {
    // The run id is how the self-retrigger guard works. Dropping it here would silently
    // disable the tightest loop-breaker in the system.
    const seen: Array<{ event: string; runId?: string }> = [];
    const events = new AutomationEvents(makeLogger());
    events.subscribe(async (event, cause) => {
      seen.push({ event, ...(cause.runId ? { runId: cause.runId } : {}) });
    });
    await events.publish("run_failed", { runId: "run-123" });
    expect(seen).toEqual([{ event: "run_failed", runId: "run-123" }]);
  });

  it("defaults the cause to empty rather than undefined", async () => {
    const seen: unknown[] = [];
    const events = new AutomationEvents(makeLogger());
    events.subscribe(async (_event, cause) => {
      seen.push(cause);
    });
    await events.publish("quota_reset");
    expect(seen).toEqual([{}]);
  });
});
