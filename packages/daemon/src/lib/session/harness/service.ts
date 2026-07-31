/**
 * The harness-quirk service: the one thing callers outside this module talk to.
 *
 * It answers two questions. How does this harness change the model of a live
 * session (`planSwitch`)? And what must happen when driving that change failed
 * part-way (`recoverFromFailedDrive`)? Keeping them together is deliberate — the
 * recovery path is only reachable from the plan that needed a picker, and the
 * source's version of this split the two across three thousand lines, which is
 * how a failed drive came to leave a live pane with an open modal.
 */

import type { PickerCleanupOutcome } from './cleanup.ts';
import { CodexPickerCleanup } from './cleanup.ts';
import { pickerFailureReport, quarantineUnconfirmedPicker, type PickerQuarantine } from './quarantine.ts';
import {
  planRuntimeSwitch,
  type HarnessRuntimeSwitchContext,
  type HarnessRuntimeSwitchRequest,
  type RuntimeSwitchPlan,
} from './runtime-switch.ts';

/** What the daemon must do after a picker drive failed. */
export type PickerRecovery =
  /** Cleanup confirmed the pane is idle. The switch failed; the session is fine. */
  | { readonly kind: 'recovered' }
  /**
   * Cleanup could not be confirmed. The session must be quarantined durably
   * BEFORE its pane is stopped, so a failure to stop still leaves the input gates
   * closed.
   */
  | { readonly kind: 'quarantine'; readonly quarantine: PickerQuarantine };

export class HarnessQuirkService {
  constructor(
    private readonly cleanup: CodexPickerCleanup,
    /** The binary name, so operator instructions name a command that exists. */
    private readonly binaryName: string,
  ) {}

  /** How to change the model or effort of a live session on this harness. */
  planSwitch(request: HarnessRuntimeSwitchRequest, context: HarnessRuntimeSwitchContext): RuntimeSwitchPlan {
    return planRuntimeSwitch(request, context);
  }

  /**
   * Recover from a picker drive that threw part-way through.
   *
   * `driveFailure` is carried into the quarantine because a session that says
   * only "cleanup failed" tells nobody what was originally being attempted.
   */
  async recoverFromFailedDrive(session: string, driveFailure: unknown): Promise<PickerRecovery> {
    const outcome: PickerCleanupOutcome = await this.cleanup.dismiss(session);
    if (outcome.kind === 'settled') return { kind: 'recovered' };
    return {
      kind: 'quarantine',
      quarantine: quarantineUnconfirmedPicker(this.binaryName, driveFailure, new Error(outcome.reason)),
    };
  }

  /**
   * The message for the caller whose switch failed, once the outcome of stopping
   * the pane is known. `stopFailure` is `undefined` when the pane was stopped.
   */
  report(quarantine: PickerQuarantine, stopFailure?: unknown): string {
    return pickerFailureReport(quarantine, stopFailure);
  }
}
