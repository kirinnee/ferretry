/**
 * The decisions behind putting a turn into a live pane.
 *
 * Delivery is the daemon's most consequential write: it types into a terminal a human may be
 * watching and an agent is being paid to act on. Every decision it makes is therefore made HERE,
 * from one observation, with no clock and no IO — the adapter owns the looping and the sleeping, and
 * this module owns what any given frame means.
 *
 * Two questions, in order. Can the pane take input at all, and if not, is what is blocking it
 * something the daemon knows how to clear? And once the payload is proven to be in the composer,
 * did pressing Enter actually deliver it?
 */

import type { LandingEvidence } from './composer.ts';
import { composerHolds, paneShowsModelSelector } from './composer.ts';
import { paneShowsActiveWork } from './pane.ts';
import type { StartupDialogAction, StartupDialogOptions } from './startup.ts';
import { startupDialogAction } from './startup.ts';

/** One observation of a pane: what tmux said about it and what it is showing. */
export interface DeliveryFrame {
  readonly alive: boolean;
  readonly dead: boolean;
  readonly promptReady: boolean;
  readonly visible: string;
  readonly exitCode?: number;
}

/**
 * How many times one KIND of dialog may be answered before the daemon stops.
 *
 * Per kind, not in total: a fresh install legitimately shows a trust prompt and then a theme picker,
 * and each is answered once. The same kind coming back three times means the keys are not clearing
 * it, and sending a fourth round into a screen that is not responding to them is how a daemon
 * types an answer into whatever appears next.
 */
export const MAX_STARTUP_DIALOG_ATTEMPTS = 3;

/** What the readiness loop should do about this frame. */
export type ReadinessStep =
  /** The pane is at a prompt and will accept input. */
  | { readonly kind: 'ready' }
  /** A recognised startup dialog is up. Send these keys, then observe again. */
  | { readonly kind: 'answer_dialog'; readonly action: StartupDialogAction; readonly attempt: number }
  /** Nothing to do but look again: the harness is booting, repainting, or mid-turn. */
  | { readonly kind: 'wait' }
  /** The pane is gone. Waiting cannot help and the caller must not keep trying. */
  | { readonly kind: 'exited'; readonly reason: string }
  /** A dialog would not close. Stopping is the safe end. */
  | { readonly kind: 'stuck'; readonly reason: string };

/**
 * Decide the next readiness step from one frame.
 *
 * The order is the safety property. A dead pane is answered first, because every other branch would
 * be reasoning about a frame that no longer exists. The dialog check comes before readiness because
 * a dialog is never `promptReady` — and it comes with its own attempt budget, since a dialog that
 * survives its keys is a screen the daemon has misread.
 */
export function nextReadinessStep(
  frame: DeliveryFrame,
  attemptsByKind: ReadonlyMap<StartupDialogAction['kind'], number>,
  options: StartupDialogOptions = {},
  maxAttempts: number = MAX_STARTUP_DIALOG_ATTEMPTS,
): ReadinessStep {
  if (!frame.alive || frame.dead) {
    return {
      kind: 'exited',
      reason:
        frame.exitCode === undefined
          ? 'the interactive harness exited; tmux reported no exit code'
          : `the interactive harness exited (${frame.exitCode})`,
    };
  }
  const action = startupDialogAction(frame.visible, options);
  if (action !== undefined) {
    const attempt = (attemptsByKind.get(action.kind) ?? 0) + 1;
    return attempt > maxAttempts
      ? { kind: 'stuck', reason: `the ${action.kind} dialog did not close after ${maxAttempts} attempts` }
      : { kind: 'answer_dialog', action, attempt };
  }
  return frame.promptReady ? { kind: 'ready' } : { kind: 'wait' };
}

/**
 * What happened after a proven composer delivery was submitted.
 *
 * `handled-local` is a success: a slash command the TUI consumes itself is delivered even though no
 * model turn follows it, and a caller that demanded a spinner would report a working delivery as a
 * failure and retype it.
 */
export type InjectionOutcome = 'turn-started' | 'handled-local';

/** What one post-submit frame proves. */
export type SubmitStep =
  /** The payload is gone from the composer; delivery is final and must NOT be repeated. */
  | { readonly kind: 'delivered'; readonly outcome: InjectionOutcome }
  /** The payload is still sitting there. Enter may have been swallowed by a repaint. */
  | { readonly kind: 'holding' };

/**
 * Classify one frame captured after pressing Enter.
 *
 * Every `delivered` branch below is a point of no return: the TUI may have consumed the payload and
 * already performed an arbitrary side effect, so pressing Enter again — or retyping — could repeat
 * it. The branches are ordered from the strongest evidence down.
 */
export function classifySubmit(frame: DeliveryFrame, text: string, evidence: LandingEvidence): SubmitStep {
  // A pane that died or started working took the payload with it either way.
  if (!frame.alive || frame.dead || paneShowsActiveWork(frame.visible))
    return { kind: 'delivered', outcome: 'turn-started' };
  // Exact `/model` opens Codex's native selector. The pane often keeps `› /model` above it, which
  // `composerHolds` cannot tell from an occupied composer — a selector heading proves the first
  // Enter was consumed, and a second one would make a choice on the user's behalf.
  if (text.trim() === '/model' && paneShowsModelSelector(frame.visible))
    return { kind: 'delivered', outcome: 'handled-local' };
  // A ready prompt is positive evidence that the cursor is back at an EMPTY composer. It is checked
  // before the pane-text probe because local output routinely echoes the command into scrollback.
  if (frame.promptReady) return { kind: 'delivered', outcome: 'handled-local' };
  // The payload left the composer and the pane is not idle: a turn beginning, a selector, or some
  // other local result. It was consumed whichever it is.
  return composerHolds(frame.visible, text, evidence)
    ? { kind: 'holding' }
    : { kind: 'delivered', outcome: 'turn-started' };
}
