/**
 * THE APPLICATION-TUNNEL FACTS THE APP'S RELAY SESSION KEEPS LOCALLY (client copy of today's
 * `packages/protocol/src/lib/relay-session.ts`).
 *
 * `docs/relay-protocol.md` §14 runs above the rendezvous channel. The values both ends derive — the 4440
 * concluded close, the one reason that may ride beside it, and the `data` record byte budget — are exported
 * ONCE, by the kernel session layer (`@ferretry/kernel/session`, R627/R628); this file declares none of them
 * and the app imports them from there. What stays here is the app-side tunnel vocabulary only.
 */

/**
 * The close a daemon sends when a session's ACCESS LEASE ran out (`docs/design/zero-trust.md` A5).
 *
 * It is NOT a refusal of the device. A lease is fifteen minutes of authority on one keyed session,
 * renewed by the device signing a daemon challenge; when nobody answered the challenge in time the
 * session ends with this code and the client opens a new one, silently. `4403` stays the only code
 * that means "this device is no longer accepted", so a client must never read this one as an unpair.
 */
export const RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE = 4441 as const;

/** How long one proof of the device key authorises one session for. */
/** @public A docs/relay-protocol.md number kept with the client's copy of the protocol; the daemon and the rendezvous enforce it. */
export const ACCESS_LEASE_SECONDS = 900 as const;

/** How long before the lease ends the daemon asks the device to sign again. */
/** @public A docs/relay-protocol.md number kept with the client's copy of the protocol; the daemon and the rendezvous enforce it. */
export const ACCESS_RENEW_LEAD_SECONDS = 120 as const;

/**
 * The most one session may live, renewals included.
 *
 * Renewal is silent, so without a cap a forgotten tab kept one session alive forever. At the cap the
 * daemon stops asking and the lease runs out with `4441`; the browser opens a new session with a fresh
 * proof, which costs it nothing a person notices — and a session that nobody's device can open again
 * (revoked, expired) ends for good.
 */
/** @public A docs/relay-protocol.md number kept with the client's copy of the protocol; the daemon and the rendezvous enforce it. */
export const MAX_SESSION_SECONDS = 43_200 as const;

/**
 * The largest request or response body the tunnel will assemble from its parts.
 *
 * A body larger than one record travels as ordered parts (`req-more`, `res-more`). This bounds what
 * either end will buffer for one id; past it a request is answered `413` and a response `502`, never
 * truncated.
 */
export const MAX_TUNNEL_BODY_BYTES = 32 * 1_024 * 1_024;

/**
 * What one UTF-16 code unit costs once it is inside a JSON string, in UTF-8 bytes.
 *
 * `JSON.stringify` escapes `"` and `\` as two characters, the five named controls as two, every other
 * control as a six-character `\uXXXX`, and a lone surrogate as `\uXXXX` too (well-formed stringify).
 * Everything else is its UTF-8 width. A surrogate PAIR is four bytes and is costed by its caller.
 */
function jsonUnitBytes(unit: number): number {
  if (unit === 0x22 || unit === 0x5c) return 2;
  if (unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d) return 2;
  if (unit < 0x20) return 6;
  if (unit < 0x80) return 1;
  if (unit < 0x800) return 2;
  if (unit >= 0xd800 && unit <= 0xdfff) return 6;
  return 3;
}

/**
 * A body cut into parts that each fit one record, never splitting a character.
 *
 * Both ends of the tunnel cut bodies — the browser its requests, the daemon its answers — so the rule
 * lives here once. `budgetBytes` is what one record has left for the body once its own envelope is
 * counted; each part's JSON-escaped UTF-8 size is at most that. A surrogate pair is never divided, so
 * every part is valid text on its own and the concatenation is the original string exactly.
 *
 * An empty body is one empty part, so every request and answer has at least one record.
 */
export function partitionTunnelBody(body: string, budgetBytes: number): readonly string[] {
  if (budgetBytes < 12) throw new Error('a tunnel record must leave room for at least one escaped character pair');
  const parts: string[] = [];
  let start = 0;
  let used = 0;
  let index = 0;
  while (index < body.length) {
    const unit = body.charCodeAt(index);
    const next = body.charCodeAt(index + 1);
    const paired = unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    const width = paired ? 2 : 1;
    const cost = paired ? 4 : jsonUnitBytes(unit);
    if (used + cost > budgetBytes) {
      parts.push(body.slice(start, index));
      start = index;
      used = 0;
    }
    used += cost;
    index += width;
  }
  parts.push(body.slice(start));
  return parts;
}

/**
 * HOW A COMPRESSED ANSWER CROSSES THE TUNNEL (`docs/relay-protocol.md` §14, "A compressed answer").
 *
 * A `res` body is a string, so gzip bytes travel as unpadded base64url under these two response
 * headers, and a caller asks for them with an ordinary `accept-encoding` request header. Nothing in
 * the envelope changed — `res` is a strict object, so a new key would be a breaking change — and a
 * client that never asks never receives one: it gets the plain body it always did. Both ends read the
 * same two names and two values from here, which is what keeps a daemon and an app from disagreeing
 * about how to tell a compressed body from a plain one.
 */
export const TUNNEL_CONTENT_ENCODING_HEADER = 'content-encoding' as const;
export const TUNNEL_GZIP_ENCODING = 'gzip' as const;
export const TUNNEL_TRANSFER_ENCODING_HEADER = 'content-transfer-encoding' as const;
export const TUNNEL_BASE64URL_TRANSFER = 'base64url' as const;
