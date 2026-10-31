/**
 * What a session actually carries, on either carrier.
 *
 * The session protocol stops at "the plaintext" (§7 of `docs/relay-protocol.md`). This module is
 * §14: one record is one JSON message, a request names its own answer, and a body that does not fit
 * one record travels as ordered parts rather than being truncated or refused.
 *
 * TWO PROPERTIES ARE THE WHOLE POINT of translating here rather than letting a session's request in
 * through a side door.
 *
 * **A session's request reaches the same route table an HTTP one reaches.** It becomes an
 * `ApiRequest` — the transport-free value every route, the router and the authorization boundary are
 * already written against — so there is no second surface to keep in step.
 *
 * **A session's request can never outrank the device that opened it.** The identity is the device the
 * session proved by signing its transcript, attached by this module as `ApiRequest.device`; an
 * `authorization` header from the peer is refused by the schema. Where the session's socket ARRIVED is
 * stamped here too, from the carrier — a relayed session is never loopback — so everything the daemon
 * grants a host caller stays out of reach by construction rather than by a check somebody has to
 * remember to write.
 */

import {
  MAX_TUNNEL_BODY_BYTES,
  PairedDeviceIdSchema,
  type PairingResponse,
  partitionTunnelBody,
  type RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE,
  type RELAY_SESSION_CONCLUDED_CLOSE_CODE,
  relayDataByteBudget,
  TUNNEL_BASE64URL_TRANSFER,
  TUNNEL_CONTENT_ENCODING_HEADER,
  TUNNEL_GZIP_ENCODING,
  TUNNEL_TRANSFER_ENCODING_HEADER,
} from '@ferretry/protocol';
import {
  AppSessionSchema,
  DeviceProofSchema,
  fromBase64Url,
  MAX_PLAINTEXT_BYTES,
  type RelayCloseCode,
  SESSION_PROTOCOL_ID,
  toBase64Url,
  utf8Bytes,
  utf8Text,
} from '@ferretry/relay';
import { z } from 'zod';
import {
  type ApiRequest,
  type ApiResponse,
  BodyTooLargeError,
  headersFrom,
  queryFrom,
  type SessionDevice,
} from '../api/http.ts';

/** The widest request identifier a client may name an answer with. */
export const MAX_TUNNEL_REQUEST_ID = 0xffff_ffff;

/**
 * Every close this link can spell, including the one that means "the outcome is inside the channel".
 *
 * `RelayCloseCode` is a closed union over the shared wire vocabulary, and the session-conclusion code
 * is owned by `@ferretry/protocol` — the application tunnel's own package — rather than restated as a
 * literal here. Both halves of that union are inside the `4000`–`4999` range §5's `closed` control
 * already carries, so a rendezvous deployed before either existed forwards them unchanged.
 */
export type RelaySessionCloseCode =
  | RelayCloseCode
  | typeof RELAY_SESSION_CONCLUDED_CLOSE_CODE
  | typeof RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE;

/**
 * Raw bytes one `data` record may carry, DERIVED and never written down.
 *
 * A record's plaintext is capped at {@link MAX_PLAINTEXT_BYTES}; what is left for the payload is that
 * minus the JSON envelope around it, with base64url's four-thirds inflation divided back out. The
 * arithmetic lives in `@ferretry/protocol` so the browser derives the same number from the same
 * function: two ends that disagreed by one byte would turn a legal write into a closed session, and a
 * hard-coded copy would drift the day the envelope changes.
 */
export const MAX_TUNNEL_DATA_BYTES = relayDataByteBudget(MAX_PLAINTEXT_BYTES);

/** Lowercase HTTP field names only: `headersFrom` lowercases, and a map that preserved case would
 *  let `Authorization` and `authorization` disagree about which one authenticated the request. */
const HeaderNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9!#$%&'*+.^_`|~-]+$/u, 'not a lowercase HTTP field name');

/** No control characters: a header value carrying CR or LF is a request-splitting attempt, and this
 *  is the boundary that can still refuse it rather than pass it to something that reassembles. */
const HeaderValueSchema = z
  .string()
  .max(4_096)
  .refine(value => !hasControlCharacter(value), 'header value carries a control character');

/** Scanned by code point rather than matched by a regex, because a regex holding the very characters
 *  it is looking for is unreadable and the linter is right to refuse one. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const RequestIdSchema = z.number().int().min(1).max(MAX_TUNNEL_REQUEST_ID);

/** Uppercase token, not an enumeration of verbs. The route table already answers `405` for a verb
 *  no route serves, and a second list here would be a second thing to keep current. */
const MethodSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[A-Z]+$/u, 'not an HTTP method');

/**
 * The daemon's own raw pathname.
 *
 * Nothing normalises it, deliberately: the authorization boundary and the handler must inspect the
 * same string, and an encoded traversal that meant one thing to one and another to the other is the
 * bug `ApiRequest.path` documents. A query belongs in `query` and a fragment means nothing to a
 * daemon, so both are refused rather than silently parsed out.
 */
const PathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .regex(/^\/(?!\/)/u, 'path must begin with exactly one slash')
  .refine(value => !/[\s?#]/u.test(value), 'path carries whitespace, a query or a fragment');

const QuerySchema = z.array(z.tuple([z.string().max(256), z.string().max(4_096)])).max(64);

/**
 * Request headers the peer chose.
 *
 * `authorization` is refused rather than overwritten. Overwriting would work and would teach the
 * next reader that the peer's header is merely ignored; refusing says what is true — a relayed
 * request carries exactly one credential, the one its session was opened with.
 */
const HeadersSchema = z.record(HeaderNameSchema, HeaderValueSchema).refine(headers => {
  return !Object.hasOwn(headers, 'authorization');
}, 'a relayed request may not carry its own authorization');

/**
 * A stream's query, refusing the two credentials a URL can carry.
 *
 * `ticket` and `token` are refused for the reason `authorization` is refused on a request: a relayed
 * session carries exactly one credential, the one it was opened with. Single-use socket tickets exist
 * only because a browser cannot put a header on a `WebSocket`, and here the credential IS the record
 * — so a ticket in this query is either a client that will burn a credential for nothing, or one
 * recovered from an access log being replayed against a boundary that deliberately holds no redeemer.
 */
const StreamQuerySchema = QuerySchema.refine(
  query => query.every(([name]) => name !== 'ticket' && name !== 'token'),
  'a relayed stream may not carry a ticket or a token in its query',
);

/** A WebSocket close code as the mounted stream surfaces spell them, carried inside the channel. */
const StreamCloseCodeSchema = z.number().int().min(1_000).max(4_999);
const StreamCloseReasonSchema = z.string().max(200);

/**
 * One run of an ordered byte stream, or one complete text frame — never both and never neither.
 *
 * Two shapes rather than one nullable field, because the two carry DIFFERENT delivery semantics and
 * a receiver that had to guess which it was handed would have to guess wrong eventually. A text frame
 * is a message and half a message is corruption; a byte run has no frame boundary worth preserving,
 * so it is delivered the moment it arrives with no reassembly, no fragment marker and no buffer
 * waiting for a frame to complete.
 *
 * It carries no `protocol` field. Every other message on this tunnel does; this one is the payload
 * envelope and repeating the dialect on every keystroke would cost bytes on the one message sent by
 * the thousand.
 */
const DataRecordSchema = z.union([
  z.strictObject({ t: z.literal('data'), text: z.string().max(MAX_PLAINTEXT_BYTES) }),
  z.strictObject({ t: z.literal('data'), bytes: z.string().max(MAX_PLAINTEXT_BYTES) }),
]);

/** The end-to-end dialect every tunnel record but `data` names. */
const Dialect = z.literal(SESSION_PROTOCOL_ID);

/**
 * A device's claim to this session: who it is, which running copy of the app, and the proof.
 *
 * The proof is checked by the link against the transcript of THIS session — see
 * `@ferretry/relay`'s `deviceAuthMessage` — so it can be neither replayed into another session nor
 * forged without the private key, which never left the browser that generated it.
 */
const DeviceClaim = {
  deviceId: PairedDeviceIdSchema,
  appSession: AppSessionSchema,
  proof: DeviceProofSchema,
} as const;

/** One part of a body that did not fit one record. The first part rides on the `req` itself. */
const BodyPartSchema = z.string().max(MAX_PLAINTEXT_BYTES);

/**
 * THE RECORD AT SEQUENCE 1 IS A STRICT UNION OF THREE, and the union is the enforcement.
 *
 * Each credential record commits its session to one job — requests, one stream, or one pairing
 * attempt — and no mode can reach another's states. "A stream session should not send requests" is a
 * rule something has to check and somebody has to remember; a session whose accepted messages have no
 * request in them is a rule nothing can break.
 */
export const RelayTunnelClientMessageSchema = z.union([
  z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('auth'), protocol: Dialect, ...DeviceClaim }),
    z.strictObject({
      t: z.literal('stream'),
      protocol: Dialect,
      ...DeviceClaim,
      path: PathSchema,
      query: StreamQuerySchema.optional(),
    }),
    z.strictObject({
      t: z.literal('pair'),
      protocol: Dialect,
      // Bounded here only so a hostile record cannot be enormous. What a code, a device name and a
      // device key may actually BE belongs to the pairing API's own schemas, which the service
      // applies — and a key or proof that is merely malformed must be refused exactly like a wrong
      // code, never as a parse failure a guesser could tell apart.
      code: z.string().min(1).max(64),
      deviceName: z.string().min(1).max(256),
      deviceKey: z.string().min(1).max(128),
      proof: z.string().min(1).max(128),
    }),
    z.strictObject({
      t: z.literal('req'),
      id: RequestIdSchema,
      method: MethodSchema,
      path: PathSchema,
      query: QuerySchema.optional(),
      headers: HeadersSchema.optional(),
      body: BodyPartSchema.optional(),
      /** More of this body follows in `req-more` records. */
      more: z.literal(true).optional(),
      /**
       * A person is at this device: the page is visible and was used recently. Only such a request
       * advances the device's idle clock, so an open background tab that renews by itself does not
       * keep a forgotten device paired forever (`docs/design/zero-trust.md` A6).
       */
      presence: z.literal(true).optional(),
    }),
    z.strictObject({
      t: z.literal('req-more'),
      id: RequestIdSchema,
      body: BodyPartSchema,
      more: z.literal(true).optional(),
    }),
    /** The device's answer to a `renew`: the same key, signing this session's transcript and the nonce. */
    z.strictObject({ t: z.literal('renewed'), protocol: Dialect, proof: DeviceProofSchema }),
    z.strictObject({
      t: z.literal('stream-close'),
      protocol: Dialect,
      code: StreamCloseCodeSchema,
      reason: StreamCloseReasonSchema,
    }),
  ]),
  DataRecordSchema,
]);
export type RelayTunnelClientMessage = z.infer<typeof RelayTunnelClientMessageSchema>;
export type RelayTunnelAuth = Extract<RelayTunnelClientMessage, { t: 'auth' }>;
export type RelayTunnelRequest = Extract<RelayTunnelClientMessage, { t: 'req' }>;
export type RelayTunnelRequestPart = Extract<RelayTunnelClientMessage, { t: 'req-more' }>;
export type RelayTunnelStream = Extract<RelayTunnelClientMessage, { t: 'stream' }>;
export type RelayTunnelPair = Extract<RelayTunnelClientMessage, { t: 'pair' }>;
export type RelayTunnelData = Extract<RelayTunnelClientMessage, { t: 'data' }>;

export type RelayTunnelDaemonMessage =
  /**
   * The device's proof verified. `accessExpiresAt` is when this session's lease ends unless renewed;
   * `rotateBy` is when the device's key is due for replacement (`docs/design/zero-trust.md` B6).
   */
  | {
      readonly t: 'authenticated';
      readonly protocol: typeof SESSION_PROTOCOL_ID;
      readonly accessExpiresAt: string;
      readonly rotateBy?: string;
    }
  | {
      readonly t: 'res';
      readonly id: number;
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
      readonly more?: true;
    }
  /** The next part of an answer whose `res` said `more`. The last part carries no `more`. */
  | { readonly t: 'res-more'; readonly id: number; readonly body: string; readonly more?: true }
  /**
   * The lease on this session is about to end: sign this nonce to keep it.
   *
   * Sent inside the channel, by the daemon, two minutes ahead — an incoming record wakes even a
   * background tab, where a client-side timer would be throttled into missing it.
   */
  | {
      readonly t: 'renew';
      readonly protocol: typeof SESSION_PROTOCOL_ID;
      readonly nonce: string;
      readonly expiresAt: string;
    }
  /**
   * A redemption that succeeded, carrying the pairing API's answer WHOLE.
   *
   * Embedded rather than re-listed field by field, so the next field the pairing API adds crosses a
   * relay the day it ships instead of being silently dropped by a copy of the list that nobody
   * remembered to update. `carriers` is the field that makes this load-bearing: it is what a
   * relay-paired device navigates by afterwards, and an envelope that lost it would mint a device
   * that can reach its daemon by nothing at all, with no error anywhere.
   */
  | { readonly t: 'paired'; readonly protocol: typeof SESSION_PROTOCOL_ID; readonly response: PairingResponse }
  /**
   * A redemption that did not succeed — every cause, one answer.
   *
   * No active code, a wrong code, an expired one, a spent budget, a key whose proof did not verify, a
   * record the pairing schema refused: all of them are this. A pre-credential surface the whole
   * internet can reach must not be an oracle.
   */
  | {
      readonly t: 'pair-refused';
      readonly protocol: typeof SESSION_PROTOCOL_ID;
      readonly reason: 'pairing_refused';
    }
  | {
      readonly t: 'stream-opened';
      readonly protocol: typeof SESSION_PROTOCOL_ID;
      readonly accessExpiresAt: string;
      readonly rotateBy?: string;
    }
  /**
   * The upgrade was refused, with everything a status can say — said BEFORE anything switched.
   *
   * `body` is required, not optional: a refusal that crossed with no explanation would leave a viewer
   * unable to tell a terminal that was never opened from a daemon that broke, which is the exact
   * confusion answering before the switch exists to avoid.
   */
  | {
      readonly t: 'stream-refused';
      readonly protocol: typeof SESSION_PROTOCOL_ID;
      readonly status: number;
      readonly body: string;
    }
  | { readonly t: 'data'; readonly text: string }
  | { readonly t: 'data'; readonly bytes: string }
  /** The stream's own close taxonomy, sealed, because a code that says why a viewer left is content. */
  | {
      readonly t: 'stream-close';
      readonly protocol: typeof SESSION_PROTOCOL_ID;
      readonly code: number;
      readonly reason: string;
    };

export function encodeTunnelMessage(message: RelayTunnelDaemonMessage): Uint8Array {
  return utf8Bytes(JSON.stringify(message));
}

/** Decode a client record. Null covers bad UTF-8, bad JSON and every shape outside the union — all
 *  of which end the session, because a peer that sent one does not know what the daemon did not
 *  understand. */
export function decodeTunnelClientMessage(plaintext: Uint8Array): RelayTunnelClientMessage | null {
  const text = utf8Text(plaintext);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = RelayTunnelClientMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A relayed caller's rate-limit identity, derived from the session the RENDEZVOUS minted.
 *
 * WHY IT EXISTS AT ALL. `ApiRequest.clientAddress` is the bucket key every rate-limited route reaches
 * for, and a relayed request used to carry none — so `rateLimitKey` fell through to its one
 * `'remote-unknown'` placeholder and EVERY relayed caller on earth shared a single fixed window.
 * Honest devices were refused because a stranger elsewhere had been busy, and the limiter looked
 * perfectly wired while protecting nothing.
 *
 * WHY THE SESSION IDENTIFIER. It is minted by the rendezvous, never by the peer, so it cannot be
 * chosen, spoofed or rotated by the caller — the property an address has on a direct hop and nothing
 * a relayed peer sends could have. It is prefixed so it can never be mistaken for a peer address by a
 * reader or collide with one in the bucket map.
 */
export function relayRateLimitIdentity(sessionId: string): string {
  return `relay-session:${sessionId}`;
}

/**
 * Where a session's socket ARRIVED, decided by the carrier that accepted it and nothing else.
 *
 * A relayed session has none: the relay terminates on the host it serves, so every relayed arrival is
 * remote whatever address it appears to carry. A DIRECT session is one socket on this daemon's own
 * listener, classified exactly as an HTTP request on that listener is — `loopback` from the socket's
 * real peer, `privilegedLoopback` from the bind — so a browser on the machine is host-local over the
 * tunnel precisely when it would have been over plain HTTP, and never because of anything it sent.
 */
export interface SessionArrival {
  readonly loopback: boolean;
  readonly privilegedLoopback: boolean;
  readonly clientAddress?: string;
  /**
   * `'tunnel'` for a session the daemon's tunnel listener accepted (§15). Pairing is never carried by a
   * tunnel: such a session's `pair` record is refused with the ordinary `pair-refused` before the
   * pairing service is asked, so no code guess is spent and no grant is recorded as direct.
   */
  readonly carrier?: 'tunnel';
}

/** Everything an `ApiRequest` needs that a credential record can supply. A stream names no method,
 *  headers or body, so it passes what it has and this fills the rest. */
export interface TunnelRequestSource {
  readonly method: string;
  readonly path: string;
  readonly query?: readonly (readonly [string, string])[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/**
 * Turn a tunnelled request or stream open into the daemon's own request value.
 *
 * THE ONE CONSTRUCTOR, and every property that makes a session caller safe rides on that. The device
 * a session proved is attached here and only here — as `device`, a field no HTTP request can carry —
 * the arrival is stamped here and only here, and so is the rate-limit identity. There is no other way
 * to build one of these, so a second surface cannot be added that forgets one of them.
 */
export function tunnelApiRequest(
  source: TunnelRequestSource,
  device: SessionDevice,
  sessionId: string,
  arrival?: SessionArrival,
  /** The carrying session's transcript hash, which a device-key rotation's proof is signed over. */
  transcriptHash?: Uint8Array,
): ApiRequest {
  const body = source.body ?? '';
  return {
    method: source.method,
    path: source.path,
    query: queryFrom(source.query ?? []),
    headers: headersFrom({ ...source.headers }),
    clientAddress: arrival?.clientAddress ?? relayRateLimitIdentity(sessionId),
    // A relay hop is never loopback, whatever address the socket appears to come from.
    loopback: arrival?.loopback ?? false,
    privilegedLoopback: arrival?.privilegedLoopback ?? false,
    device,
    ...(transcriptHash === undefined ? {} : { transcriptHash }),
    // The route's own bound applies to a session's body exactly as it does to an HTTP one: a body the
    // tunnel reassembled up to 32 MiB is still refused by a route that reads at most 512 KiB.
    text: async limitBytes => {
      if (limitBytes !== undefined && utf8Bytes(body).byteLength > limitBytes) throw new BodyTooLargeError(limitBytes);
      return body;
    },
  };
}

/** The upgrade a stream session asks for. `GET` because every mounted socket route is one, and a
 *  method the peer could choose would be a second way to reach the route table. */
export function tunnelStreamRequest(
  stream: RelayTunnelStream,
  sessionId: string,
  arrival?: SessionArrival,
): ApiRequest {
  return tunnelApiRequest(
    { method: 'GET', path: stream.path, query: stream.query },
    { deviceId: stream.deviceId, appSession: stream.appSession },
    sessionId,
    arrival,
  );
}

/**
 * One frame from a live stream, as a record — or `null` when it does not fit one.
 *
 * `null` is the caller's decision to make rather than this function's, because what an over-budget
 * frame MEANS differs per stream: a terminal redraw is superseded by the next one and is dropped,
 * while an event is a unique journal record that may be neither dropped nor split.
 */
export function tunnelDataMessage(frame: string | Uint8Array): RelayTunnelDaemonMessage | null {
  const message: RelayTunnelDaemonMessage =
    typeof frame === 'string' ? { t: 'data', text: frame } : { t: 'data', bytes: toBase64Url(frame) };
  return encodeTunnelMessage(message).byteLength > MAX_PLAINTEXT_BYTES ? null : message;
}

/** A client `data` record as the socket handler expects it: text stays text, bytes decode. `null` is
 *  a `bytes` value that is not unpadded base64url, which ends the session like any unparseable record. */
export function tunnelDataFrame(data: RelayTunnelData): string | Uint8Array | null {
  return 'text' in data ? data.text : fromBase64Url(data.bytes);
}

/** The widest `res-more` envelope, so a part is cut to fit beside it. */
const RES_MORE_ENVELOPE = encodeTunnelMessage({ t: 'res-more', id: MAX_TUNNEL_REQUEST_ID, body: '', more: true });

/**
 * The answer to one request, as the records that carry it.
 *
 * One record when the answer fits one; otherwise the `res` carries the status, headers and the first
 * part with `more`, and `res-more` records carry the rest in order. This replaces the old `oversize`
 * refusal: the direct carrier now runs through this tunnel too, and a LAN that used to answer a large
 * session list uncapped must not start refusing it. Past {@link MAX_TUNNEL_BODY_BYTES} the answer is a
 * `502` naming the size — never a truncated body a client would parse and believe.
 *
 * An answer the dispatcher compressed (`response.gzip`) travels as its gzip bytes in unpadded base64url
 * under `content-encoding: gzip` and `content-transfer-encoding: base64url`, so the size rules above
 * apply to what is actually sent. The compression happened before this, and the channel seals what it is
 * handed: compress-then-encrypt. The envelope is unchanged — see {@link TUNNEL_GZIP_ENCODING}.
 */
export function tunnelResponseMessages(id: number, response: ApiResponse): readonly RelayTunnelDaemonMessage[] {
  const compressed = response.gzip !== undefined;
  const headers = {
    ...Object.fromEntries(response.headers),
    ...(compressed
      ? {
          [TUNNEL_CONTENT_ENCODING_HEADER]: TUNNEL_GZIP_ENCODING,
          [TUNNEL_TRANSFER_ENCODING_HEADER]: TUNNEL_BASE64URL_TRANSFER,
        }
      : {}),
  };
  const wireBody = response.gzip === undefined ? response.body : toBase64Url(response.gzip);
  const whole: RelayTunnelDaemonMessage = { t: 'res', id, status: response.status, headers, body: wireBody };
  if (encodeTunnelMessage(whole).byteLength <= MAX_PLAINTEXT_BYTES) return [whole];
  const bodyBytes = utf8Bytes(wireBody).byteLength;
  if (bodyBytes > MAX_TUNNEL_BODY_BYTES)
    return [
      {
        t: 'res',
        id,
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'answer_too_large',
            message: `the daemon's answer is ${bodyBytes} bytes, over the ${MAX_TUNNEL_BODY_BYTES}-byte limit one session carries`,
          },
        }),
      },
    ];
  const head = encodeTunnelMessage({ ...whole, body: '', more: true }).byteLength;
  const budget = MAX_PLAINTEXT_BYTES - Math.max(head, RES_MORE_ENVELOPE.byteLength);
  const parts = partitionTunnelBody(wireBody, budget);
  return parts.map((body, index): RelayTunnelDaemonMessage => {
    const more = index < parts.length - 1 ? ({ more: true } as const) : {};
    return index === 0 ? { ...whole, body, ...more } : { t: 'res-more', id, body, ...more };
  });
}
