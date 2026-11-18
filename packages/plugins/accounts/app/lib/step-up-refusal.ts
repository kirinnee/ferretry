/**
 * The ask-card hosts read the daemon while a chat is open, which is the page's own work, not the owner acting. Those
 * reads are QUIET (the client raises no passkey prompt for them), so a daemon that wants a step-up answers
 * `403 grant_step_up_required` and the host shows a short "Confirm it's you to see this" button instead of the data.
 * Pressing it reads again, NOT quiet, and that is when the passkey is asked for. The daemon's refusal still stands, so
 * nothing is shown or done without the step-up.
 */

import { STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';

/** The words on the button an ask card draws while the owner has not yet confirmed. */
export const CONFIRM_TO_SEE_WORDS = 'Confirm it’s you to see this';

/** Whether a read was refused only for want of the step-up (a 403 with the step-up code), not refused outright. */
export const isStepUpRefusal = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'status' in cause &&
  cause.status === 403 &&
  'code' in cause &&
  cause.code === STEP_UP_REQUIRED_CODE;

/**
 * How a read is made. A card's own background read (a mount, a poll) is `quiet`: no passkey prompt for it, and the
 * host shows "Confirm it's you to see this" when the daemon wants a step-up. A read the owner pressed for is not.
 */
export interface ReadMode {
  readonly quiet?: boolean;
}

/** The call init a read mode stands for: nothing, or `quiet`. */
export const quietInit = (read: ReadMode): { readonly quiet: true } | Record<string, never> =>
  read.quiet === true ? { quiet: true } : {};
