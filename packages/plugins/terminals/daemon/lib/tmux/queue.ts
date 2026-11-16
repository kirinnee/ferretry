import type { LandingEvidence } from './composer.ts';
import { composerHolds } from './composer.ts';
import { type HeldAt, heldAt, readComposer, readPendingInputs, showsPayload } from './composer-screen.ts';
import type { DeliveryFrame } from './delivery.ts';
import { frameCursor } from './delivery.ts';

/**
 * The decisions behind putting a message into a BUSY pane's own queue.
 *
 * Both harness TUIs hold text typed mid-turn and submit it at the next turn boundary, which is what
 * makes a send to a working agent possible at all. It is a different problem from `delivery.ts`: that
 * module proves a payload LEFT the composer, and here leaving the composer is only half the answer —
 * the payload has to turn up in the harness's own queue, or "queued" is a word the daemon made up.
 *
 * There is no readiness gate on this path by design. The pane is expected to be mid-turn; waiting for
 * a prompt is precisely what the caller decided not to do.
 */

/**
 * Whether the pane is asking for a second key before it will hold the message.
 *
 * Codex mid-turn can keep the text in the composer and render a "tab to queue message" hint. The
 * match is tolerant of wording and spacing drift but anchored to those words, so a stale or unrelated
 * frame can never trigger a blind extra keystroke into a live agent's terminal.
 */
const QUEUE_HINT = /tab\s+to\s+queue/iu;

/** True when the pane wants the queue key AND the payload is still sitting where it was typed. */
export function needsQueueKey(frame: DeliveryFrame, text: string, evidence: LandingEvidence): boolean {
  return QUEUE_HINT.test(frame.visible) && queuedWhere(frame, text, evidence) === 'composer';
}

/**
 * Where a busy pane is holding the payload: still typed in the composer, waiting in the harness's own
 * queue, or nowhere this frame can show.
 *
 * Read from the composer line and the queue block above it — Codex's `↳ <text>` entries under
 * `Messages to be submitted…` or `Queued follow-up inputs`, Claude's `❯ <text>` messages over
 * `ctrl+x ctrl+s to send now` — never from the payload's words appearing somewhere on screen. That
 * older search called a message "queued" because its text was visible in the conversation it had
 * ALREADY been submitted into (`hello` inside `› hihello`). A frame with no readable composer still
 * reads the queue block first, and falls back to that search only when no block shows the payload:
 * the fallback would otherwise call a message sitting in Claude's queue "typed".
 */
export function queuedWhere(frame: DeliveryFrame, text: string, evidence: LandingEvidence): HeldAt | undefined {
  const cursor = frameCursor(frame);
  if (readComposer(frame.visible, cursor)?.placeholder !== undefined)
    return heldAt(frame.visible, cursor, text, evidence === 'placeholder');
  if (readPendingInputs(frame.visible).some(entry => showsPayload(entry, text))) return 'queue';
  return composerHolds(frame.visible, text, evidence) ? 'composer' : undefined;
}
