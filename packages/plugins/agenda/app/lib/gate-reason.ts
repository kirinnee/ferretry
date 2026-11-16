/**
 * THE LONGEST REASON A "NOT GOOD" CARRIES. The card's move back is Board's, and so is its limit (2 KiB, Board's
 * `MAX_BOARD_REASON_LENGTH`); this half imports nothing of Board's, so it states the same number for the words box to
 * refuse in the owner's own words before anything is sent.
 */
export const GATE_REASON_LENGTH_LIMIT = 2 * 1024;

/** The sentence an over-long reason is refused with, today's words. */
export const gateReasonTooLong = (): string =>
  `That is too long: keep it under ${String(GATE_REASON_LENGTH_LIMIT)} characters.`;
