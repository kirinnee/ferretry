/** The send-id prefix daemon-written messages used before the agenda rename (batches and nudges alike). */
const LEGACY_SEND_PREFIX = 'attention-';
const SEND_PREFIX = 'agenda-';

/** A send id in the spelling this daemon writes, whichever spelling it was read in. */
export function canonicalSendId(sendId: string): string {
  return sendId.startsWith(LEGACY_SEND_PREFIX) ? `${SEND_PREFIX}${sendId.slice(LEGACY_SEND_PREFIX.length)}` : sendId;
}

/**
 * Whether two send ids name ONE send. A batch or nudge sent as `attention-…` before an upgrade and asked for
 * again as `agenda-…` after it is the same send: the ledger must say it was already sent, never type it twice.
 */
export function sameSendId(a: string, b: string): boolean {
  return canonicalSendId(a) === canonicalSendId(b);
}
