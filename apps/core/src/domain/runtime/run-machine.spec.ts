import { describe, expect, it } from "vitest";
import { recoverable, nonRecoverable, conflict } from "@signet/contracts";
import { afterPhaseComplete, afterPhaseFailure, nextPhase, recoveryDecision } from "./run-machine.js";

describe("phase progression", () => {
  it("walks the full order and succeeds after FINALIZE", () => {
    expect(nextPhase("ASSEMBLE_PACK")).toBe("CREATE_WORKSPACE");
    expect(nextPhase("FINALIZE")).toBeNull();
    expect(afterPhaseComplete("FINALIZE")).toEqual({ kind: "succeed" });
    expect(afterPhaseComplete("GATES")).toEqual({ kind: "enter_phase", phase: "FINALIZE", attempt: 1 });
  });
});

describe("failure policy (the constitution's repair budget)", () => {
  const base = {
    phase: "GATES" as const,
    repairAttempt: 0,
    freshRestarts: 0,
    maxRepairIterations: 3,
    maxFreshRestarts: 1,
    quotaResetsAt: null,
  };

  it("recoverable gate failure → repair, up to the cap", () => {
    const d = afterPhaseFailure({ ...base, error: recoverable("gates.tests_failed", "2 tests failed") });
    expect(d).toEqual({ kind: "repair", attempt: 1 });
  });

  it("repair budget exhausted → one fresh restart", () => {
    const d = afterPhaseFailure({
      ...base,
      repairAttempt: 3,
      error: recoverable("gates.tests_failed", "still failing"),
    });
    expect(d.kind).toBe("fresh_restart");
  });

  it("restart budget exhausted → escalate to a human, never loop", () => {
    const d = afterPhaseFailure({
      ...base,
      repairAttempt: 3,
      freshRestarts: 1,
      error: recoverable("gates.tests_failed", "still failing"),
    });
    expect(d.kind).toBe("escalate");
  });

  it("quota limit → park with reset time, burning no repair budget", () => {
    const resetsAt = new Date(Date.now() + 3600_000);
    const d = afterPhaseFailure({
      ...base,
      phase: "AGENT_IMPLEMENT",
      error: recoverable("adapter.limit_reached", "5-hour limit"),
      quotaResetsAt: resetsAt,
    });
    expect(d).toEqual({ kind: "park", resumeAt: resetsAt });
  });

  it("non-recoverable → fail immediately", () => {
    const d = afterPhaseFailure({ ...base, error: nonRecoverable("adapter.refusal", "policy refusal") });
    expect(d.kind).toBe("fail");
  });

  it("conflict → fail without consuming repair budget (dispatcher re-queues)", () => {
    const d = afterPhaseFailure({ ...base, error: conflict("workspace.locked", "worktree lock held") });
    expect(d.kind).toBe("fail");
  });
});

describe("crash recovery (the completer)", () => {
  it("resumes an interrupted implement when a session exists", () => {
    const d = recoveryDecision({ status: "PHASE", phase: "AGENT_IMPLEMENT", attempt: 1 }, true);
    expect(d).toEqual({ kind: "enter_phase", phase: "AGENT_IMPLEMENT", attempt: 1 });
  });
  it("re-enters other phases with a bumped attempt", () => {
    const d = recoveryDecision({ status: "PHASE", phase: "GATES", attempt: 1 }, false);
    expect(d).toEqual({ kind: "enter_phase", phase: "GATES", attempt: 2 });
  });
  it("does nothing for terminal runs", () => {
    expect(recoveryDecision({ status: "SUCCEEDED" }, false)).toBeNull();
  });
});
