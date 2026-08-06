/**
 * THE APPLICATION-TUNNEL FACTS BOTH ENDS OF A RELAY SESSION MUST AGREE ON.
 *
 * `docs/relay-protocol.md` §14 runs above the rendezvous channel, and the daemon link and the
 * browser session each implement their own half of it. The two values here are the ones that would
 * otherwise be derived twice — once per end — and an invisible disagreement between two derivations
 * is the expensive kind. They live in THIS package rather than in `@ferretry/relay` deliberately:
 * the rendezvous neither emits nor interprets either of them (it forwards any close code in the
 * 4000–4999 range untouched, and it cannot read a sealed record at all), so they are endpoint
 * vocabulary, and this is the one package both endpoints already share. `@ferretry/relay` also
 * depends on this package, so the import can never point the other way.
 */

/**
 * The close a daemon sends after a session's outcome has already crossed inside the channel.
 *
 * §14 ends a pairing session (after `paired` or `pair-refused`) and a stream session (after a
 * sealed `stream-close` or `stream-refused`) with this one code, so an observer outside the channel
 * — the rendezvous included — reads the same close for every conclusion and learns nothing from it.
 * A session that receives this close WITHOUT a sealed outcome having crossed first must report a
 * protocol violation rather than a quiet end: the code promises an outcome was stated, and an
 * outcome nobody received is missing evidence, not an empty answer.
 */
export const RELAY_SESSION_CONCLUDED_CLOSE_CODE = 4440 as const;

/** The one-record envelope a §14 `data` record wraps around a run of raw bytes. */
const DATA_RECORD_ENVELOPE_BYTES = JSON.stringify({ t: 'data', bytes: '' }).length;

/**
 * The largest run of raw bytes one §14 `data` record can carry, derived rather than hard-coded.
 *
 * A record's plaintext ceiling is the relay protocol's (`MAX_PLAINTEXT_BYTES`, passed in by the
 * caller so this package stays independent of `@ferretry/relay`); the payload travels as unpadded
 * base64url inside the exact JSON envelope above. Base64url spends four characters per three bytes
 * — every character ASCII, so JSON escaping adds nothing — which makes the budget
 * `floor(3/4 × (ceiling − envelope))`. Both ends MUST take this number from here: a client that
 * splits terminal input at its own guess of the budget hands the daemon a record the seal refuses,
 * and the session ends over an arithmetic disagreement nobody can see on the wire.
 *
 * Total on purpose: a ceiling too small to fit the envelope yields `0` — nothing fits — rather
 * than a negative number a caller would have to remember to clamp.
 */
export function relayDataByteBudget(maxPlaintextBytes: number): number {
  const encodedBudget = Math.floor(maxPlaintextBytes) - DATA_RECORD_ENVELOPE_BYTES;
  if (!Number.isFinite(encodedBudget) || encodedBudget <= 0) return 0;
  return Math.floor((encodedBudget * 3) / 4);
}
