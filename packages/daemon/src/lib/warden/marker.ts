/**
 * Reading the done marker a teammate's `signal done` left behind.
 *
 * THIS IS THE READER `FileSignalArtifacts` WAS WAITING FOR. That writer records
 * the TURN each marker certifies, and its own header says why: a later turn bumps
 * the persisted turn before it is delivered, so a daemon death in that window
 * would leave a marker from an older turn sitting next to a session that is on a
 * newer one. A reader that ignored the turn would let it certify work that never
 * ran.
 *
 * WHY THE WARDEN NEEDS IT. `detect.ts` refuses to call a failed or stalled session
 * "abandoned wreckage" when a marker certifies its current turn: the work FINISHED
 * and the failed status is a bookkeeping gap, so resuming it would make a finished
 * teammate redo its turn. Without a reader that guard is dead and every
 * finished-but-unrecorded session is reported as wreckage every sweep.
 *
 * THE DIRECTION OF DOUBT. Every unreadable case answers `false` — no marker, empty
 * file, unparseable JSON, a missing or non-numeric turn, a turn that is not this
 * one. `false` means the session is FLAGGED for a warden to look at, which costs a
 * check; `true` would mean "a teammate declared this finished", which suppresses
 * one. Guessing `true` from a corrupt marker is the failure mode the warden
 * doctrine forbids, so ambiguity always resolves toward looking.
 *
 * Pure: the document arrives as text.
 */

import { z } from 'zod';

/**
 * The marker document, as its writer produces it.
 *
 * `turn` is required here even though the writer has always recorded one: a marker
 * without it cannot be compared against anything, and treating "no turn recorded"
 * as "certifies whatever turn you are asking about" is exactly the stale-marker
 * bug the turn field exists to prevent.
 */
const DoneMarkerSchema = z.object({
  at: z.string().min(1),
  type: z.literal('done'),
  turn: z.number().int().min(0),
});

/**
 * True when this marker document certifies `turn`.
 *
 * A marker from an EARLIER turn is refused, and so is one from a later turn: a
 * marker ahead of the session's recorded turn means the two disagree about which
 * turn is current, and disagreement is not evidence that the work is done.
 */
export function doneMarkerCertifiesTurn(document: string | undefined, turn: number): boolean {
  if (document === undefined || document.trim() === '') return false;
  let value: unknown;
  try {
    value = JSON.parse(document);
  } catch {
    return false;
  }
  const parsed = DoneMarkerSchema.safeParse(value);
  return parsed.success && parsed.data.turn === turn;
}

/** The marker's filename inside a session's own directory. A CONTRACT with the
 *  writer and with the revive that clears it — see `FileSignalArtifacts`. */
export const DONE_MARKER_FILENAME = 'done.marker';
