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

/**
 * THE ONLY REASON THAT MAY RIDE BESIDE THAT CODE ON THE WIRE.
 *
 * A `closed` control frame is UNSEALED by design — the rendezvous has to read the session identifier
 * to route it — so every byte of its `reason` is plaintext to the carrier. §14 says the observer
 * outside the channel "reads the same close for every conclusion and learns nothing from it", and a
 * per-outcome reason is exactly what deletes that: a viewer's own `stream-close` text is
 * reader-supplied content, and even the daemon's fixed vocabulary ("stream reader fell behind",
 * "a stream frame exceeds one relay record") tells a relay operator WHY people stop watching — which
 * is the disclosure `RELAY_STREAM_CLOSES` in the daemon's link already says the sealed record exists
 * to prevent.
 *
 * IT IS A CONSTANT RATHER THAN A CONVENTION. A parameter that callers are trusted to pass a safe
 * value into is a rule somebody has to remember; one shared string with nowhere to interpolate is a
 * rule nothing can break. Nothing is lost by it: the real code and reason have already crossed
 * inside the sealed record this close follows, which is the whole meaning of `4440`.
 */
export const RELAY_SESSION_CONCLUDED_CLOSE_REASON = 'the session concluded' as const;

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
export const ACCESS_LEASE_SECONDS = 900 as const;

/** How long before the lease ends the daemon asks the device to sign again. */
export const ACCESS_RENEW_LEAD_SECONDS = 120 as const;

/**
 * The most one session may live, renewals included.
 *
 * Renewal is silent, so without a cap a forgotten tab kept one session alive forever. At the cap the
 * daemon stops asking and the lease runs out with `4441`; the browser opens a new session with a fresh
 * proof, which costs it nothing a person notices — and a session that nobody's device can open again
 * (revoked, expired) ends for good.
 */
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
 * How a person updates the machine, in the words every surface uses.
 *
 * One string so the daemon, the command line and the app cannot name different commands. Each one
 * is a real installation path (INSTALLATION.md); there is no `fy upgrade` verb, so none is named. Plain
 * text, no backticks: the sentence is shown as-is on a phone, where markup would read as noise.
 */
export const DAEMON_UPDATE_COMMANDS =
  'brew upgrade --cask ferretry, nix profile upgrade, your apt or dnf upgrade, or the install script again';

/** What an UPDATED app says to a machine still running the Ferretry from before device keys. */
export const OLDER_DAEMON_SENTENCE =
  `This machine is running an older Ferretry than this app. Update it on the machine (${DAEMON_UPDATE_COMMANDS}), ` +
  'then run fy daemon restart and pair this device again.';

/** What an UPDATED machine says to an app from before device keys. */
export const OLDER_APP_SENTENCE =
  'This app is older than the machine it is talking to. Reload the page, or close and reopen the installed app, ' +
  'to update it, then pair this device again.';

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
