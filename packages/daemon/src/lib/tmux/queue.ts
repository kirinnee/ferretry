import type { LandingEvidence } from './composer.ts';
import { composerHolds } from './composer.ts';
import { paneShowsActiveWork } from './pane.ts';

/**
 * The decisions behind putting a message into a BUSY pane's own queue.
 *
 * Both harness TUIs hold text typed mid-turn and submit it at the next turn boundary, which is what
 * makes a send to a working agent possible at all. It is a different problem from `delivery.ts`: that
 * module proves a payload LEFT the composer, and here leaving the composer would be the failure —
 * the payload is supposed to stay visible, held, until the turn it is queued behind ends.
 *
 * There is no readiness gate on this path by design. The pane is expected to be mid-turn; waiting for
 * a prompt is precisely what the caller decided not to do.
 */

/**
 * Whether the pane is asking for a second key before it will hold the message.
 *
 * Codex mid-turn does not submit on Enter: it keeps the text in the composer and renders a "tab to
 * queue message" hint. The match is tolerant of wording and spacing drift but anchored to those
 * words, so a stale or unrelated frame can never trigger a blind extra keystroke into a live agent's
 * terminal.
 */
const QUEUE_HINT = /tab\s+to\s+queue/iu;

/** True when the pane wants the queue key AND the payload is still sitting where it was typed. */
export function needsQueueKey(frame: string, text: string, evidence: LandingEvidence): boolean {
  return QUEUE_HINT.test(frame) && composerHolds(frame, text, evidence);
}

/**
 * Whether the pane shows positive evidence that the message is queued.
 *
 * Either the payload is still visible — Claude echoes the queued line, Codex keeps it in the composer
 * or its queue — or the pane is visibly working and about to consume it. A frame with NEITHER means
 * the submit landed on an idle prompt or was swallowed, and reporting that as queued would tell a
 * caller their message is waiting when it is simply gone.
 */
export function queueAccepted(frame: string, text: string, evidence: LandingEvidence): boolean {
  return composerHolds(frame, text, evidence) || paneShowsActiveWork(frame);
}
