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

import { paneShowsOpenPicker } from '../session/harness/picker-screen.ts';
import type { LandingEvidence } from './composer.ts';
import { composerHolds } from './composer.ts';
import { composerContains, readComposer, showsPayload } from './composer-screen.ts';
import { paneShowsActiveWork } from './pane.ts';
import type { StartupDialogAction, StartupDialogOptions } from './startup.ts';
import { startupDialogAction } from './startup.ts';

/** One observation of a pane: what tmux said about it and what it is showing. */
export interface DeliveryFrame {
  readonly alive: boolean;
  readonly dead: boolean;
  readonly promptReady: boolean;
  readonly visible: string;
  /**
   * The pane's scrollback, carried only for a dead pane: tmux redraws a dead pane's screen with its
   * "Pane is dead" line and the last lines the process printed survive only here.
   */
  readonly history?: string;
  readonly exitCode?: number;
  /** Where tmux put the cursor, which is what tells a composer's placeholder from typed input. */
  readonly cursorX?: number | undefined;
  readonly cursorY?: number | undefined;
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

/** At most this many of a dead pane's last non-blank lines are quoted in its exit reason. */
const EXIT_OUTPUT_LINES = 3;

/** And at most this many characters of them, so one runaway line cannot flood a card. */
const EXIT_OUTPUT_CHARACTERS = 300;

/**
 * Why a pane is gone, in words a card can show: the exit status tmux kept, and the last thing the
 * process printed.
 *
 * The status alone says nothing a reader can act on — "exited (2)" is every CLI's usage error and
 * every shell's syntax error — while the last lines are the program's own explanation: the wrapper's
 * refusal naming a missing secret, the harness rejecting a flag. Control characters are dropped so a
 * colour code or a stray escape cannot reach a surface that renders the reason. The scrollback is read
 * when there is one, because a dead pane's screen no longer shows what was printed just before it died.
 */
export function harnessExitReason(frame: Pick<DeliveryFrame, 'exitCode' | 'visible' | 'history'>): string {
  const status =
    frame.exitCode === undefined
      ? 'the interactive harness exited; tmux reported no exit code'
      : `the interactive harness exited (${frame.exitCode})`;
  const output = frame.history === undefined || frame.history.trim() === '' ? frame.visible : frame.history;
  const lines = output
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/^Pane is dead\b/u.test(line));
  const tail = lines.slice(-EXIT_OUTPUT_LINES).join(' / ');
  if (tail.length === 0) return status;
  const quoted = tail.length > EXIT_OUTPUT_CHARACTERS ? `…${tail.slice(-EXIT_OUTPUT_CHARACTERS)}` : tail;
  return `${status}: its last output was "${quoted}"`;
}

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
    return { kind: 'exited', reason: harnessExitReason(frame) };
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
  // Exact `/model` opens Codex's native picker. The pane often keeps `› /model` above it, which
  // `composerHolds` cannot tell from an occupied composer — an OPEN picker proves the first Enter
  // was consumed, and a second one would make a choice on the user's behalf.
  //
  // The question is asked of `picker-screen.ts`, which owns the title table and the classification,
  // rather than of a local regex holding a partial copy of it. That copy knew two of the five
  // titles and missed the quick picker's bare `Select Model` entirely, so the commonest `/model`
  // outcome was reported here as a started turn.
  if (text.trim() === '/model' && paneShowsOpenPicker(frame.visible))
    return { kind: 'delivered', outcome: 'handled-local' };
  // A ready prompt is positive evidence that the cursor is back at an EMPTY composer. It is checked
  // before the pane-text probe because local output routinely echoes the command into scrollback.
  if (frame.promptReady) return { kind: 'delivered', outcome: 'handled-local' };
  // The payload left the composer and the pane is not idle: a turn beginning, a selector, or some
  // other local result. It was consumed whichever it is.
  return stillComposed(frame, text, evidence) ? { kind: 'holding' } : { kind: 'delivered', outcome: 'turn-started' };
}

/**
 * Whether the composer itself still holds the payload — alone, or beside other text.
 *
 * Read from the composer line and the cursor, not by finding the payload's words anywhere on screen:
 * once submitted, a message is echoed into the conversation above, so a whole-frame search keeps
 * answering "still there" for a payload that is long gone. A frame with no readable composer falls
 * back to that older search, which errs towards pressing Enter again — safe only because this is
 * asked solely while the payload has not yet been seen to leave.
 */
function stillComposed(frame: DeliveryFrame, text: string, evidence: LandingEvidence): boolean {
  const composer = readComposer(frame.visible, { x: frame.cursorX, y: frame.cursorY });
  if (composer === undefined || composer.placeholder === undefined) return composerHolds(frame.visible, text, evidence);
  if (composer.placeholder) return false;
  return evidence === 'placeholder' ? composer.pasted : composerContains(composer.text, text);
}

/**
 * What the composer holds before anything is typed, as far as one frame can PROVE it.
 *
 * `empty` — nothing, or a placeholder the cursor (or the harness's own wording) shows nobody typed.
 * `input` — text the cursor proves is typed. `unreadable` — no composer line at all, or text the
 * cursor cannot place, which may be a person's draft. Only `empty` may ever be typed into: treating
 * "could not tell" as "empty" is how a turn pointer was typed onto a person's half-written question.
 */
export type ComposerState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'input'; readonly text: string }
  | { readonly kind: 'unreadable' };

export function composerState(frame: DeliveryFrame): ComposerState {
  const composer = readComposer(frame.visible, { x: frame.cursorX, y: frame.cursorY });
  if (composer === undefined) return { kind: 'unreadable' };
  if (composer.text === '' || composer.placeholder === true) return { kind: 'empty' };
  return composer.placeholder === false ? { kind: 'input', text: composer.text } : { kind: 'unreadable' };
}

/**
 * The input a composer already holds before anything is typed, or `undefined` when it is empty.
 *
 * Typing onto it is never right. It is a person's half-written draft, or an earlier message that was
 * typed and never submitted, and a new payload appended to either is submitted as ONE message — the
 * real failure behind a `hi` and a `hello` reaching Codex as `hihello`, with neither send able to
 * prove its own delivery afterwards. Only a cursor-proven input counts: a placeholder, or a frame
 * whose cursor tmux did not report, is not a draft.
 */
export function occupiedComposer(frame: DeliveryFrame): string | undefined {
  const composer = readComposer(frame.visible, { x: frame.cursorX, y: frame.cursorY });
  return composer?.placeholder === false && composer.text !== '' ? composer.text : undefined;
}

/**
 * What the composer itself proves about a payload just typed into an EMPTY composer.
 *
 * `unreadable` when the frame has no composer line or no cursor on it: the caller then falls back to
 * comparing character counts across frames, which is weaker but not wrong. Because typing only ever
 * starts from an empty composer, the composer showing exactly the payload is proof that THIS copy
 * landed.
 */
export function composerLanding(
  frame: DeliveryFrame,
  text: string,
  paste: boolean,
): LandingEvidence | 'unreadable' | undefined {
  const composer = readComposer(frame.visible, { x: frame.cursorX, y: frame.cursorY });
  if (composer === undefined || composer.placeholder === undefined) return 'unreadable';
  if (composer.placeholder) return undefined;
  if (showsPayload(composer.text, text)) return 'chars';
  return paste && composer.pasted ? 'placeholder' : undefined;
}

/**
 * Whether the pane has drawn anything since `before` — the only sign a TUI has READ what was typed.
 *
 * Keys typed into a pane wait in its pty until the harness reads them, and a harness that is stalled —
 * a throttled or napping host, a long synchronous render — reads nothing and draws nothing for
 * seconds. Its composer then reads EMPTY while the keys are still on their way, and "empty after
 * typing" was taken as "the keys never arrived": the daemon typed again, and again, and the stalled
 * pane later drew all three copies (measured on Claude Code 2.1.281 frozen for 6 s). An empty
 * composer proves the keys were dropped only once the pane has demonstrably drawn since they were sent.
 */
export function paneResponded(before: DeliveryFrame, after: DeliveryFrame): boolean {
  return after.visible !== before.visible || after.cursorX !== before.cursorX || after.cursorY !== before.cursorY;
}

/** How long a fill waits for its payload to show, as the pane's own latency stretches it. */
export interface LandingWindow {
  /** The wait for a pane that drew promptly. */
  readonly windowMs: number;
  /** The ceiling, reached only by a pane that drew nothing at all, or drew late. */
  readonly stalledWindowMs: number;
  /** How long after the pane first drew to keep looking, since an echo can take a further repaint. */
  readonly settleMs: number;
}

/**
 * When a fill stops looking, given when (if ever) the pane first drew after the typing.
 *
 * A pane that has drawn nothing is stalled, not refusing, so it is waited on up to the ceiling. One
 * that drew is given `settleMs` past its first repaint, and never less than the ordinary window: a slow
 * host stretches the wait in proportion to how slow it measurably is, and a responsive one does not.
 */
export function landingDeadlineMs(window: LandingWindow, respondedAtMs: number | undefined): number {
  if (respondedAtMs === undefined) return window.stalledWindowMs;
  return Math.min(window.stalledWindowMs, Math.max(window.windowMs, respondedAtMs + window.settleMs));
}
