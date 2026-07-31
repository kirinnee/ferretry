/**
 * Closing a Codex picker the daemon failed to drive.
 *
 * A half-driven picker is the dangerous state: the modal is open, it consumes
 * keystrokes, and anything the daemon types next lands in it. Cleanup therefore
 * has to end in one of exactly two places — the pane is provably back at an idle
 * prompt, or the session is quarantined.
 *
 * The source drove this on a wall clock: escape, sleep 50ms, escape, … for two
 * seconds, then give up. That is a race with a timeout bolted on — on a loaded
 * host it fails for lack of time rather than for lack of a working escape, and
 * the number of keys it sends into the pane depends on how fast the machine is.
 *
 * This is the deterministic version. Every decision is made from the LAST
 * capture, the number of keys that can ever be sent is a fixed bound, and the
 * terminal condition is an observation rather than an elapsed duration. Nothing
 * here reads a clock.
 */

import { parseCodexPickerScreen, type CodexPickerScreen } from './picker-screen.ts';

/** How many Escapes are sent before cleanup is declared unconfirmed. Codex
 *  closes each nested picker with one Escape and nests at most quick-models →
 *  reasoning → advanced-reasoning → plan-scope, so four is one per level with a
 *  spare; a picker that survives that is not going to close. */
export const MAX_PICKER_DISMISS_ATTEMPTS = 5;

/** What cleanup observed on the pane it resolved at the start. */
export interface PickerPaneObservation {
  readonly visiblePane: string;
  /** True when the pane's cursor sits at an idle harness prompt. */
  readonly promptReady: boolean;
}

/** The next thing cleanup should do. */
export type PickerDismissStep =
  /** The pane is provably idle. Nothing was left open. */
  | { readonly kind: 'settled' }
  /** Send one Escape, then observe again. */
  | { readonly kind: 'send_escape'; readonly attempt: number }
  /** Stop. The pane cannot be confirmed idle, so the session must be quarantined. */
  | { readonly kind: 'unconfirmed'; readonly reason: string };

/** tmux pane ids are `%<digits>`; anything else is not an address cleanup may act
 *  on, and resolving one is the only thing that pins cleanup to a single pane. */
export function isAddressablePaneId(paneId: string): boolean {
  return /^%\d+$/.test(paneId);
}

/** What the pane is showing, for a message a human has to act on. */
function describe(screen: CodexPickerScreen): string {
  return screen.title ?? screen.kind;
}

/**
 * Decide the next cleanup step from one observation.
 *
 * The ordering is the safety property:
 *
 * 1. Nothing open AND the prompt is ready — settled, and no key was sent.
 * 2. Nothing recognisable open but no idle prompt either — the screen is
 *    UNKNOWN. Refuse without sending anything: Escape into an unknown screen is
 *    a keystroke into an unidentified modal, which is the exact hazard cleanup
 *    exists to avoid.
 * 3. A parsed picker with attempts remaining — Escape, then re-observe.
 * 4. A parsed picker with the budget spent — unconfirmed.
 */
export function nextPickerDismissStep(
  observation: PickerPaneObservation,
  attemptsSoFar: number,
  maxAttempts: number = MAX_PICKER_DISMISS_ATTEMPTS,
): PickerDismissStep {
  const screen = parseCodexPickerScreen(observation.visiblePane);
  if (screen.kind === 'none') {
    return observation.promptReady
      ? { kind: 'settled' }
      : {
          kind: 'unconfirmed',
          reason: 'the pane shows neither a recognised Codex picker nor an idle prompt, so no key was sent into it',
        };
  }
  if (attemptsSoFar >= maxAttempts) {
    return {
      kind: 'unconfirmed',
      reason: `${describe(screen)} was still open after ${maxAttempts} dismiss attempts`,
    };
  }
  return { kind: 'send_escape', attempt: attemptsSoFar + 1 };
}
