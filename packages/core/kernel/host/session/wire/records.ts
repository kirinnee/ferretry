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

import { z } from 'zod';
import { type ApiRequest, type ApiResponse, finalised, headersFrom, queryFrom } from '../../../contract/http.ts';
import { BodyTooLargeError } from '../../../contract/body.ts';
import type { CarrierKey } from '../../../contract/ids.ts';
import type { SessionPrincipal } from '../../../contract/session.ts';
import { fromBase64Url, toBase64Url, utf8Bytes, utf8Text } from './binary.ts';
import { MAX_PLAINTEXT_BYTES, type SessionCloseCode, SESSION_PROTOCOL_ID } from './constants.ts';
import { MemberAuthRecordSchema, MemberJoinOptionsRecordSchema, MemberJoinRecordSchema } from './member.ts';
import { AppSessionSchema, DeviceProofSchema } from './proofs.ts';
import {
  DEVICE_ID_PATTERN,
  MAX_TUNNEL_BODY_BYTES,
  partitionTunnelBody,
  type RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE,
  type RELAY_SESSION_CONCLUDED_CLOSE_CODE,
  relayDataByteBudget,
  TUNNEL_BASE64URL_TRANSFER,
  TUNNEL_CONTENT_ENCODING_HEADER,
  TUNNEL_GZIP_ENCODING,
  TUNNEL_TRANSFER_ENCODING_HEADER,
} from './vocabulary.ts';

const PairedDeviceIdSchema = z.string().regex(DEVICE_ID_PATTERN, 'invalid device id');

/** The widest request identifier a client may name an answer with. */
export const MAX_REQUEST_ID = 0xffff_ffff;

/**
 * Every close this link can spell, including the one that means "the outcome is inside the channel".
 *
 * `SessionCloseCode` is a closed union over the shared wire vocabulary, and the session-conclusion code
 * is owned by `@ferretry/protocol` — the application tunnel's own package — rather than restated as a
 * literal here. Both halves of that union are inside the `4000`–`4999` range §5's `closed` control
 * already carries, so a rendezvous deployed before either existed forwards them unchanged.
 */
export type SessionEndCode =
  | SessionCloseCode
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
export const MAX_DATA_BYTES = relayDataByteBudget(MAX_PLAINTEXT_BYTES);

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

const RequestIdSchema = z.number().int().min(1).max(MAX_REQUEST_ID);

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
 * THE RECORD AT SEQUENCE 1 IS A STRICT UNION OF FIVE, and the union is the enforcement.
 *
 * Each credential record commits its session to one job — a device's requests, one stream, one pairing
 * attempt, one join by a shared-catalog member, or a member's requests — and no mode can reach another's states. "A stream session should not send requests" is a
 * rule something has to check and somebody has to remember; a session whose accepted messages have no
 * request in them is a rule nothing can break.
 */
export const ClientRecordSchema = z.union([
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
    // A join and a member session are the other two jobs a credential record can commit to. Their shapes
    // are the relay package's, so the browser and this daemon cannot disagree about them.
    MemberJoinRecordSchema,
    MemberJoinOptionsRecordSchema,
    MemberAuthRecordSchema,
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
export type ClientRecord = z.infer<typeof ClientRecordSchema>;
export type ClientAuthRecord = Extract<ClientRecord, { t: 'auth' }>;
export type ClientRequestRecord = Extract<ClientRecord, { t: 'req' }>;
export type ClientRequestPartRecord = Extract<ClientRecord, { t: 'req-more' }>;
export type ClientStreamRecord = Extract<ClientRecord, { t: 'stream' }>;
export type ClientPairRecord = Extract<ClientRecord, { t: 'pair' }>;
export type ClientJoinRecord = Extract<ClientRecord, { t: 'join' }>;
export type ClientJoinOptionsRecord = Extract<ClientRecord, { t: 'join-options' }>;
export type ClientMemberRecord = Extract<ClientRecord, { t: 'member' }>;
export type ClientDataRecord = Extract<ClientRecord, { t: 'data' }>;

export type DaemonRecord =
  /**
   * A member join's outcome, already padded to its fixed size (`padJoinOutcome`), sealed as the plaintext it is.
   * Carried as text rather than a shape so nobody can send an unpadded one by building the object.
   */
  | { readonly t: 'join-outcome'; readonly text: string }
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
  | { readonly t: 'paired'; readonly protocol: typeof SESSION_PROTOCOL_ID; readonly response: unknown }
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

export function encodeDaemonRecord(message: DaemonRecord): Uint8Array {
  if (message.t === 'join-outcome') return utf8Bytes(message.text);
  return utf8Bytes(JSON.stringify(message));
}

/** Decode a client record. Null covers bad UTF-8, bad JSON and every shape outside the union — all
 *  of which end the session, because a peer that sent one does not know what the daemon did not
 *  understand. */
export function decodeClientRecord(plaintext: Uint8Array): ClientRecord | null {
  const text = utf8Text(plaintext);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ClientRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * What the log may say about a record the daemon could not read: its KIND and the SHAPE of what was wrong.
 *
 * A session that ends on an unparseable record said nothing for it, so a browser sending a field the schema
 * refuses looked like a dead rendezvous. This is the one description that is safe to write down: every word of
 * it comes from this module's own vocabulary — a record kind from {@link CLIENT_RECORD_KINDS}, a field name
 * from {@link LOGGABLE_FIELDS}, a zod issue code — and anything else the peer chose (an unknown kind, a header
 * name, a stray key) is collapsed to `unknown` / `*`. No value, id, proof, path text or token can reach it, and
 * the test that pins this feeds it a record made of nothing but secrets.
 */
export interface UnreadableRecord {
  /** The record's `t` when it is one of ours, `unknown` when the peer named another, `none` when it named nothing. */
  readonly kind: string;
  /** Why it could not be read: not UTF-8, not JSON, or a JSON value outside every shape. */
  readonly cause: 'not-utf8' | 'not-json' | 'shape';
  /** `code@field.path` for each thing wrong, at most {@link MAX_LOGGED_ISSUES}; empty unless `cause` is `shape`. */
  readonly issues: readonly string[];
}

/** Every record `t` a client may send: the only values `kind` ever reports as itself. */
const CLIENT_RECORD_KINDS: ReadonlySet<string> = new Set([
  'auth',
  'stream',
  'pair',
  'join',
  'join-options',
  'member',
  'req',
  'req-more',
  'renewed',
  'stream-close',
  'data',
]);

/** Field names the records above define: the only path segments an issue reports as themselves. */
const LOGGABLE_FIELDS: ReadonlySet<string> = new Set([
  't',
  'protocol',
  'deviceId',
  'appSession',
  'proof',
  'code',
  'deviceName',
  'deviceKey',
  'clientName',
  'memberKey',
  'boxKey',
  'passkey',
  'origin',
  'keyId',
  'id',
  'method',
  'path',
  'query',
  'headers',
  'body',
  'more',
  'presence',
  'reason',
  'text',
  'bytes',
]);

const MAX_LOGGED_ISSUES = 8;

function loggablePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(record)';
  return path
    .map(segment => {
      if (typeof segment === 'number') return '#';
      return typeof segment === 'string' && LOGGABLE_FIELDS.has(segment) ? segment : '*';
    })
    .join('.');
}

/** A union's issue holds each arm's issues; the arm that is nearest the peer's record is the useful one. */
function leafIssues(issues: readonly z.core.$ZodIssue[], out: string[], prefix: readonly PropertyKey[]): void {
  for (const issue of issues) {
    if (out.length >= MAX_LOGGED_ISSUES) return;
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union') {
      const arm = issue.errors.reduce<readonly z.core.$ZodIssue[] | undefined>(
        (best, candidate) => (best === undefined || candidate.length < best.length ? candidate : best),
        undefined,
      );
      if (arm !== undefined && arm.length > 0) {
        leafIssues(arm, out, path);
        continue;
      }
    }
    out.push(`${issue.code}@${loggablePath(path)}`);
  }
}

/** Describe why a plaintext is not a client record, for the log. Total: it never throws and never echoes the peer. */
export function describeUnreadableRecord(plaintext: Uint8Array): UnreadableRecord {
  const text = utf8Text(plaintext);
  if (text === null) return { kind: 'none', cause: 'not-utf8', issues: [] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'none', cause: 'not-json', issues: [] };
  }
  const named = typeof value === 'object' && value !== null ? (value as { readonly t?: unknown }).t : undefined;
  const kind = typeof named !== 'string' ? 'none' : CLIENT_RECORD_KINDS.has(named) ? named : 'unknown';
  const parsed = ClientRecordSchema.safeParse(value);
  const issues: string[] = [];
  if (!parsed.success) leafIssues(parsed.error.issues, issues, []);
  return { kind, cause: 'shape', issues };
}

/**
 * A carried caller's rate-limit identity, derived from the session the carrier minted (R264).
 *
 * `ApiRequest.clientAddress` is the bucket key every rate-limited route reaches for; a carried request that
 * carried none would fall through to one shared placeholder, and every remote caller on earth would share a
 * single window. The session identifier is minted by the carrier (the rendezvous, or a direct socket), never
 * chosen by the peer's records, so it cannot be spoofed or rotated by the caller. A carrier that knows the
 * peer's address (a direct socket) passes it instead. Prefixed with the carrier key so it can never be read as
 * a peer address or collide with one in the bucket map.
 */
export function carriedRateLimitIdentity(carrier: CarrierKey, sessionId: string): string {
  return `${carrier}-session:${sessionId}`;
}

/** Everything an `ApiRequest` needs that a credential record can supply. A stream names no method,
 *  headers or body, so it passes what it has and this fills the rest. */
export interface RecordRequestSource {
  readonly method: string;
  readonly path: string;
  readonly query?: readonly (readonly [string, string])[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Where a carried session came from, stamped on every request it makes. */
export interface CarriedOrigin {
  readonly carrier: CarrierKey;
  /** The rate-limit identity ({@link carriedRateLimitIdentity}, or the carrier's peer address). */
  readonly clientAddress: string;
}

/**
 * Turn a session's request or stream open into the kernel's own request value.
 *
 * THE ONE CONSTRUCTOR, and every property that makes a session caller safe rides on that. The arrival is
 * `carried` and nothing else (G15, R625: relayed loopback is remote; a carrier cannot build a local arrival),
 * the principal is the one the kernel stamped after the session's mode verified its holder (R74: no bearer),
 * and the rate-limit identity is the carrier's (R264). There is no other way to build one of these.
 */
export function sessionApiRequest(
  source: RecordRequestSource,
  principal: SessionPrincipal,
  origin: CarriedOrigin,
  /** The carrying session's transcript hash, which a step-up or a key rotation is bound to. */
  transcriptHash?: Uint8Array,
): ApiRequest {
  const body = source.body ?? '';
  return {
    method: source.method,
    path: source.path,
    query: queryFrom(source.query ?? []),
    headers: headersFrom({ ...source.headers }),
    clientAddress: origin.clientAddress,
    arrival: { kind: 'carried', carrier: origin.carrier },
    principal,
    ...(transcriptHash === undefined ? {} : { transcriptHash }),
    // The route's own bound applies to a session's body exactly as it does to an HTTP one: a body the
    // session reassembled up to 32 MiB is still refused by a route that reads at most 512 KiB.
    text: async limitBytes => {
      if (limitBytes !== undefined && utf8Bytes(body).byteLength > limitBytes) throw new BodyTooLargeError(limitBytes);
      return body;
    },
  };
}

/** The upgrade a stream session asks for. `GET` because every socket route is one, and a method the
 *  peer could choose would be a second way to reach the route table. */
export function sessionStreamRequest(
  stream: ClientStreamRecord,
  principal: SessionPrincipal,
  origin: CarriedOrigin,
  transcriptHash?: Uint8Array,
): ApiRequest {
  return sessionApiRequest(
    { method: 'GET', path: stream.path, query: stream.query },
    principal,
    origin,
    transcriptHash,
  );
}

/**
 * One frame from a live stream, as a record — or `null` when it does not fit one.
 *
 * `null` is the caller's decision to make rather than this function's, because what an over-budget
 * frame MEANS differs per stream: a terminal redraw is superseded by the next one and is dropped,
 * while an event is a unique journal record that may be neither dropped nor split.
 */
export function streamDataRecord(frame: string | Uint8Array): DaemonRecord | null {
  const message: DaemonRecord =
    typeof frame === 'string' ? { t: 'data', text: frame } : { t: 'data', bytes: toBase64Url(frame) };
  return encodeDaemonRecord(message).byteLength > MAX_PLAINTEXT_BYTES ? null : message;
}

/** A client `data` record as the socket handler expects it: text stays text, bytes decode. `null` is
 *  a `bytes` value that is not unpadded base64url, which ends the session like any unparseable record. */
export function streamDataFrame(data: ClientDataRecord): string | Uint8Array | null {
  return 'text' in data ? data.text : fromBase64Url(data.bytes);
}

/** The widest `res-more` envelope, so a part is cut to fit beside it. */
const RES_MORE_ENVELOPE = encodeDaemonRecord({ t: 'res-more', id: MAX_REQUEST_ID, body: '', more: true });

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
export function responseRecords(id: number, answer: ApiResponse): readonly DaemonRecord[] {
  const response = finalised(answer);
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
  const whole: DaemonRecord = { t: 'res', id, status: response.status, headers, body: wireBody };
  if (encodeDaemonRecord(whole).byteLength <= MAX_PLAINTEXT_BYTES) return [whole];
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
  const head = encodeDaemonRecord({ ...whole, body: '', more: true }).byteLength;
  const budget = MAX_PLAINTEXT_BYTES - Math.max(head, RES_MORE_ENVELOPE.byteLength);
  const parts = partitionTunnelBody(wireBody, budget);
  return parts.map((body, index): DaemonRecord => {
    const more = index < parts.length - 1 ? ({ more: true } as const) : {};
    return index === 0 ? { ...whole, body, ...more } : { t: 'res-more', id, body, ...more };
  });
}
