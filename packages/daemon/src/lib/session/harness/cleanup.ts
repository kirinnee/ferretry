/**
 * Driving picker cleanup to a decided end.
 *
 * The loop is bounded by ATTEMPTS, not by a deadline. That is the whole
 * difference from the source: a cleanup that fails now fails because Escape did
 * not close the picker, never because the host was busy for two seconds. The
 * settle wait between a key and the next capture is a redraw allowance, not the
 * termination condition — dropping it to zero changes how many attempts are
 * needed, never whether cleanup can succeed.
 */

import type { SleepPort } from '../../runtime/boot.ts';
import { isAddressablePaneId, nextPickerDismissStep, MAX_PICKER_DISMISS_ATTEMPTS } from './dismiss.ts';
import type { CodexPickerPanePort } from './ports.ts';
import { failureMessage } from './quarantine.ts';

export type PickerCleanupOutcome =
  /** The pane is provably back at an idle prompt. */
  | { readonly kind: 'settled' }
  /** The pane cannot be confirmed idle. The caller must quarantine the session. */
  | { readonly kind: 'unconfirmed'; readonly reason: string };

export interface PickerCleanupPolicy {
  /** Redraw allowance between an Escape and the next capture. */
  readonly settleMs: number;
  readonly maxAttempts: number;
}

export const defaultPickerCleanupPolicy: PickerCleanupPolicy = {
  settleMs: 50,
  maxAttempts: MAX_PICKER_DISMISS_ATTEMPTS,
};

export class CodexPickerCleanup {
  constructor(
    private readonly pane: CodexPickerPanePort,
    private readonly sleeper: SleepPort,
    private readonly policy: PickerCleanupPolicy = defaultPickerCleanupPolicy,
  ) {}

  /**
   * Close whatever picker the session has open, or report that it could not be
   * confirmed closed.
   *
   * Every failure of the underlying pane commands becomes `unconfirmed` rather
   * than an exception: the caller's next move is the same either way — quarantine
   * — and an inspection that could not run is no more proof of an idle prompt
   * than a picker that would not close.
   */
  async dismiss(session: string): Promise<PickerCleanupOutcome> {
    try {
      const paneId = await this.pane.resolvePaneId(session);
      if (!isAddressablePaneId(paneId)) {
        return { kind: 'unconfirmed', reason: `tmux returned "${paneId}", which is not a pane cleanup can address` };
      }
      for (let attempts = 0; ; ) {
        const step = nextPickerDismissStep(await this.pane.observe(paneId), attempts, this.policy.maxAttempts);
        if (step.kind === 'settled') return { kind: 'settled' };
        if (step.kind === 'unconfirmed') return { kind: 'unconfirmed', reason: step.reason };
        // Re-observed before the NEXT key: if Codex has meanwhile changed the pane
        // to an idle or unrecognised screen, the loop above stops instead of
        // typing into it.
        await this.pane.sendEscape(paneId);
        attempts = step.attempt;
        await this.sleeper.sleep(this.policy.settleMs);
      }
    } catch (error) {
      return { kind: 'unconfirmed', reason: `the pane could not be inspected: ${failureMessage(error)}` };
    }
  }
}
