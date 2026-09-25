// The run state machine — pure functions, no IO. The RunEngine (services layer)
// executes these decisions; this module only decides. Keeping decisions pure
// makes crash-recovery testable without a database.

import {
  RUN_PHASE_ORDER,
  type RunPhaseName,
  type RunState,
  type SignetError,
  assertNever,
} from "@signet/contracts";

export type RunDecision =
  | { kind: "enter_phase"; phase: RunPhaseName; attempt: number }
  | { kind: "succeed" }
  | { kind: "fail"; error: SignetError }
  | { kind: "park"; resumeAt: Date | null } // quota exhausted
  | { kind: "repair"; attempt: number } // re-enter AGENT_IMPLEMENT
  | { kind: "fresh_restart" }
  | { kind: "escalate"; question: string };

/** Next phase after `phase`, or null when it was the last. */
export function nextPhase(phase: RunPhaseName): RunPhaseName | null {
  const i = RUN_PHASE_ORDER.indexOf(phase);
  const next = RUN_PHASE_ORDER[i + 1];
  return next ?? null;
}

/** Decide what follows a successfully completed phase. */
export function afterPhaseComplete(phase: RunPhaseName): RunDecision {
  const next = nextPhase(phase);
  if (next === null) return { kind: "succeed" };
  return { kind: "enter_phase", phase: next, attempt: 1 };
}

/**
 * Decide what follows a phase failure, given the error kind and the
 * increment's repair/restart budget (constitution: 2–3 repairs, 1 restart,
 * then a human).
 */
export function afterPhaseFailure(input: {
  phase: RunPhaseName;
  error: SignetError;
  repairAttempt: number;
  freshRestarts: number;
  maxRepairIterations: number;
  maxFreshRestarts: number;
  quotaResetsAt: Date | null;
}): RunDecision {
  const { error } = input;
  switch (error.kind) {
    case "conflict":
      // Another actor holds a resource (worktree lock, etc.) — never burn a
      // repair attempt on contention; the dispatcher re-queues.
      return { kind: "fail", error };
    case "non_recoverable":
      return { kind: "fail", error };
    case "recoverable": {
      if (error.code === "adapter.limit_reached") {
        return { kind: "park", resumeAt: input.quotaResetsAt };
      }
      // Gate failures during GATES phase drive the repair loop.
      if (input.phase === "GATES" || input.phase === "AGENT_IMPLEMENT") {
        if (input.repairAttempt < input.maxRepairIterations) {
          return { kind: "repair", attempt: input.repairAttempt + 1 };
        }
        if (input.freshRestarts < input.maxFreshRestarts) {
          return { kind: "fresh_restart" };
        }
        return {
          kind: "escalate",
          question:
            `Increment exhausted its repair budget (${input.maxRepairIterations} repairs, ` +
            `${input.maxFreshRestarts} restart). Last failure: ${error.message}`,
        };
      }
      return { kind: "fail", error };
    }
    default:
      return assertNever(error.kind);
  }
}

/**
 * Recovery decision for a run found mid-phase at boot (the completer).
 * Phases before AGENT_IMPLEMENT are safely re-enterable (their effects are
 * idempotency-keyed); an interrupted implement resumes the agent session when
 * a SessionRef exists, else re-enters the phase fresh.
 */
export function recoveryDecision(state: RunState, hasSessionRef: boolean): RunDecision | null {
  if (state.status !== "PHASE") return null;
  if (state.phase === "AGENT_IMPLEMENT" && hasSessionRef) {
    return { kind: "enter_phase", phase: "AGENT_IMPLEMENT", attempt: state.attempt }; // resume path
  }
  return { kind: "enter_phase", phase: state.phase, attempt: state.attempt + 1 };
}
