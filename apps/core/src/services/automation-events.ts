// A one-line indirection that breaks a dependency cycle.
//
// The workflow engine needs Signatures (to approve) and Controls (to create), so those
// cannot ask for the engine at construction time. But the things that should TRIGGER a
// workflow live inside them: a merge, a failed run, a batch of proposed rules.
//
// Rather than three lazy getters or three settable hooks scattered across three
// services, everything publishes here and the engine subscribes once at boot. The
// publisher does not know whether anybody is listening, which is exactly the property
// that removes the cycle.
//
// Two deliberate properties:
//
//   · Publishing NEVER throws. An automation failing must not make the thing that
//     triggered it look like it failed — a merge that already happened is done, and a
//     workflow erroring afterwards does not change that.
//   · With no subscriber, publishing is a no-op. Tests and any future headless mode get
//     the real services without automation attached.

import type { WorkflowEvent } from "@signet/contracts";
import type { Logger } from "../domain/runtime/logger.js";

export interface AutomationCause {
  /**
   * What produced this event. Used to ignore events caused by automation's own runs,
   * which is the tightest possible trigger loop.
   */
  runId?: string;
  depth?: number;
}

type Sink = (event: WorkflowEvent, cause: AutomationCause) => Promise<void>;

export class AutomationEvents {
  private sink: Sink | null = null;

  constructor(private readonly log: Logger) {}

  /** Attached at boot, once both sides exist. */
  subscribe(sink: Sink): void {
    this.sink = sink;
  }

  /**
   * Fire and forget, errors swallowed and logged. The caller has already done its work;
   * this is a notification, not part of the transaction.
   */
  async publish(event: WorkflowEvent, cause: AutomationCause = {}): Promise<void> {
    if (!this.sink) return;
    try {
      await this.sink(event, cause);
    } catch (e) {
      this.log.error("automation.publish_failed", { event, error: String(e) });
    }
  }
}
