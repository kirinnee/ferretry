/**
 * What a relay session actually carries.
 *
 * The session protocol stops at "the plaintext" (§7 of `docs/relay-protocol.md`). This module is
 * §14: one record is one JSON message, a request names its own answer, and an answer that does not
 * fit one record is a typed refusal rather than a truncated body.
 *
 * TWO PROPERTIES ARE THE WHOLE POINT of translating here rather than letting a relayed request in
 * through a side door.
 *
 * **A relayed request reaches the same route table a direct one reaches.** It becomes an
 * `ApiRequest` — the transport-free value every route, the router and the authorization boundary are
 * already written against — so there is no second surface to keep in step and no route that is
 * reachable one way and not the other.
 *
 * **A relayed request can never outrank the grant that opened its session.** The credential is the
 * device token the client authenticated with, put on by this module; an `authorization` header from
 * the peer is refused by the schema. And a relayed peer is never loopback, so everything the daemon
 * grants a loopback caller — a token in a query parameter, a host-scoped route — is out of reach by
 * construction rather than by a check somebody has to remember to write.
 */

import { MAX_PLAINTEXT_BYTES, RELAY_PROTOCOL_ID, utf8Bytes, utf8Text } from '@ferretry/relay';
import { z } from 'zod';
import { type ApiRequest, type ApiResponse, headersFrom, queryFrom } from '../api/http.ts';

/** The widest request identifier a client may name an answer with. */
export const MAX_TUNNEL_REQUEST_ID = 0xffff_ffff;

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

export const RelayTunnelClientMessageSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('auth'),
    protocol: z.literal(RELAY_PROTOCOL_ID),
    deviceToken: z.string().min(1).max(4_096),
  }),
  z.strictObject({
    t: z.literal('req'),
    id: RequestIdSchema,
    method: MethodSchema,
    path: PathSchema,
    query: QuerySchema.optional(),
    headers: HeadersSchema.optional(),
    body: z.string().max(MAX_PLAINTEXT_BYTES).optional(),
  }),
]);
export type RelayTunnelClientMessage = z.infer<typeof RelayTunnelClientMessageSchema>;
export type RelayTunnelRequest = Extract<RelayTunnelClientMessage, { t: 'req' }>;

export type RelayTunnelDaemonMessage =
  | { readonly t: 'authenticated'; readonly protocol: typeof RELAY_PROTOCOL_ID }
  | {
      readonly t: 'res';
      readonly id: number;
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }
  /** The answer exists and does not fit one record. Named, with its size, rather than truncated. */
  | { readonly t: 'oversize'; readonly id: number; readonly status: number; readonly byteLength: number };

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
 * Turn a relayed request into the daemon's own request value.
 *
 * The device token is attached here and only here. A caller cannot forget to, because there is no
 * other way to build one of these.
 */
export function tunnelApiRequest(request: RelayTunnelRequest, deviceToken: string): ApiRequest {
  const body = request.body ?? '';
  return {
    method: request.method,
    path: request.path,
    query: queryFrom(request.query ?? []),
    headers: headersFrom({ ...request.headers, authorization: `Bearer ${deviceToken}` }),
    // A relay hop is never loopback, whatever address the socket appears to come from.
    loopback: false,
    text: async () => body,
  };
}

/**
 * The answer to one relayed request, or the refusal that says it did not fit.
 *
 * Encoded twice on the oversize path — once to measure, once by the caller to send. That is a few
 * microseconds on the rare path, and the alternative is a size limit computed in two places that
 * could disagree about the envelope.
 */
export function tunnelResponseMessage(id: number, response: ApiResponse): RelayTunnelDaemonMessage {
  const message: RelayTunnelDaemonMessage = {
    t: 'res',
    id,
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: response.body,
  };
  const encoded = encodeTunnelMessage(message);
  if (encoded.byteLength <= MAX_PLAINTEXT_BYTES) return message;
  return { t: 'oversize', id, status: response.status, byteLength: encoded.byteLength };
}
