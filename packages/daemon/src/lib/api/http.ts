/**
 * Transport-free HTTP values.
 *
 * The daemon's API surface is decided here and served by an adapter. Nothing in this file knows
 * about `Request`, `Response`, sockets or Bun: a route is a pure function from an `ApiRequest` to
 * an `ApiResponse`, which is why the whole routing, authorization and rendering surface is
 * exercised in the unit tier without binding a port.
 */

/** Request headers, keyed by their LOWERCASED name. HTTP header names are case-insensitive and a
 *  map that preserved case would let `Authorization` and `authorization` disagree. */
export type ApiHeaders = ReadonlyMap<string, string>;

/** Query parameters. A list per key because `?sessionId=a&sessionId=b` is meaningful. */
export type QueryParameters = ReadonlyMap<string, readonly string[]>;

/** Path parameters captured by the router, RAW — never percent-decoded. See `decodeParameter`. */
export type RouteParameters = ReadonlyMap<string, string>;

export interface ApiRequest {
  readonly method: string;
  /** The RAW pathname. Never normalized: an encoded traversal must not be able to reach a route
   *  by looking like a different path than the one authorization inspected. */
  readonly path: string;
  readonly query: QueryParameters;
  readonly headers: ApiHeaders;
  /** Transport-observed peer address, used only as a rate-limit bucket key. */
  readonly clientAddress?: string;
  /** Whether the peer is on the loopback interface. Query-parameter tokens are honoured only for
   *  loopback peers, so a token can never travel in a loggable URL across a network hop. */
  readonly loopback: boolean;
  /**
   * Whether this carrier can prove that a loopback peer is the machine itself rather than a remote
   * caller forwarded through a locally bound proxy. It is deliberately separate from `loopback`:
   * the immediate TCP peer is useful for existing local transport rules, but cannot authorize an
   * anonymous public privileged-only route when the daemon advertises a foreign proxy address.
   *
   * Carriers that do not provide that proof leave this absent. Public privileged-only routes then
   * fail closed; ordinary authenticated locality rules continue to use `loopback` as before.
   */
  readonly privilegedLoopback?: boolean;
  /**
   * Fires when the caller gives up, so a long read can stop instead of finishing for nobody.
   *
   * Optional because most handlers answer in one read and have nothing to abandon, and requiring it
   * would make every request fixture carry a signal nothing asks about. A handler that ignores it is
   * correct; one that walks a whole working tree is the case this exists for.
   */
  readonly signal?: AbortSignal;
  /**
   * Reads the body as text, under a byte bound when one is stated.
   *
   * Lazy so a route that needs no body never pays to buffer one, and so a protocol switch — which
   * has no body to read and a socket to hand over instead — never touches it at all.
   *
   * `limitBytes` is a bound on the read ITSELF, not a check afterwards: see `readBoundedBody` for
   * what an implementation must do with it, and {@link BodyTooLargeError} for how it refuses.
   * Omitting it reads whatever the transport already admitted, which is what a caller that has no
   * schema to bound — and no allocation of its own to protect — wants.
   */
  readonly text: (limitBytes?: number) => Promise<string>;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

/** Lowercases header names so callers may write them however they like. */
export function headersFrom(entries: Readonly<Record<string, string>>): ApiHeaders {
  return new Map(Object.entries(entries).map(([name, value]) => [name.toLowerCase(), value]));
}

/** Builds the query map from repeated `[key, value]` pairs, preserving order and duplicates. */
export function queryFrom(entries: Iterable<readonly [string, string]>): QueryParameters {
  const query = new Map<string, string[]>();
  for (const [key, value] of entries) {
    const existing = query.get(key);
    if (existing === undefined) query.set(key, [value]);
    else existing.push(value);
  }
  return query;
}

/** A header value, or `undefined` when absent. */
export function headerValue(request: ApiRequest, name: string): string | undefined {
  return request.headers.get(name.toLowerCase());
}

/** Every value given for a query key, in order. */
export function queryValues(request: ApiRequest, name: string): readonly string[] {
  return request.query.get(name) ?? [];
}

/** The FIRST value given for a query key. Later duplicates are ignored rather than concatenated:
 *  a repeated parameter is a client mistake and picking one deterministically beats inventing a
 *  value neither side sent. */
export function queryValue(request: ApiRequest, name: string): string | undefined {
  return queryValues(request, name)[0];
}

/**
 * Raised by an `ApiRequest.text` implementation asked to read a body larger than its bound.
 *
 * Its own type rather than an `ApiError`, because detecting the excess and answering for it are
 * different jobs: the bound is enforced wherever the bytes actually arrive, and `parseBody` restates
 * every such refusal as one 413 with one code. A body refused by this daemon's reader therefore looks
 * to a client exactly like a body the runtime refused for it.
 */
export class BodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`the request body is over the ${limitBytes}-byte limit`);
    this.name = 'BodyTooLargeError';
  }
}

/** A body still on the wire: the length its sender CLAIMED, the pieces as they arrive, and how to
 *  stop the ones that will never be wanted. */
export interface BoundedBodySource {
  /** The `content-length` the caller stated, verbatim and untrusted. Absent for a chunked body. */
  readonly declaredLength?: string | undefined;
  /** The body's pieces, produced only once iteration begins — so a refusal before that reads nothing. */
  chunks(): AsyncIterable<Uint8Array>;
  /**
   * Abandons the rest of the body without reading it.
   *
   * Required, not optional, because a refusal that only stops READING leaves the sender still sending:
   * the bytes keep arriving at a daemon that has already answered 413 and will never look at another
   * one. An implementation with genuinely nothing to stop still has to say so.
   */
  discard(): Promise<void>;
}

/**
 * Reads a body as text under a byte bound, refusing BEFORE the allocation the bound exists to
 * prevent.
 *
 * Two refusals, because a caller cannot be made to tell the truth about its own length. A declared
 * length over the bound is refused without reading a byte, which is what makes an oversized upload
 * cheap to turn away. A length that was absent, malformed, or simply a lie is caught while the pieces
 * are consumed: the running total is checked before each piece is appended, so the most this ever
 * holds is the bound plus one piece. A cap applied to a string the transport has already buffered is
 * a cap applied after the allocation it was meant to prevent — the same reasoning the socket frame
 * cap is built on.
 *
 * EITHER refusal abandons the body on its way out, and both do it here rather than in the source's
 * own cleanup: whoever refuses is who knows the rest is unwanted, and one rule beats two places that
 * have to agree. A read that FAILED is left alone — a stream that broke has nothing left in flight,
 * and the reason it broke is the caller's to hear.
 *
 * The mid-read refusal BREAKS OUT OF THE LOOP before it abandons anything, and the order is
 * load-bearing rather than tidy. Leaving the loop is what closes the iterator, and closing the
 * iterator is what makes the source let go of the body; abandoning it from inside the loop asks a
 * source to stop a stream it is still holding open, which fails quietly and leaves the sender sending.
 */
export async function readBoundedBody(source: BoundedBodySource, limitBytes: number): Promise<string> {
  const declared = declaredLength(source.declaredLength);
  if (declared !== undefined && declared > limitBytes) {
    await abandon(source);
    throw new BodyTooLargeError(limitBytes);
  }
  const decoder = new TextDecoder();
  let consumed = 0;
  let text = '';
  let refused = false;
  for await (const chunk of source.chunks()) {
    consumed += chunk.byteLength;
    if (consumed > limitBytes) {
      refused = true;
      break;
    }
    // Decoded as a stream, so a multi-byte character split across two pieces survives the join.
    text += decoder.decode(chunk, { stream: true });
  }
  if (refused) {
    await abandon(source);
    throw new BodyTooLargeError(limitBytes);
  }
  return text + decoder.decode();
}

/**
 * Stops the rest of a refused body, and never reports how that went.
 *
 * The refusal is the caller's answer. Abandoning a body whose stream has already failed rejects with
 * the very error that failed it, so a cleanup that surfaced its own outcome would replace a 413 the
 * client can act on with one it cannot — or leave the rejection unhandled entirely.
 *
 * The `try` has to wrap the *call*, not the promise it returns. `discard()` is typed as returning a
 * promise, but a plain function that throws satisfies that type — `never` is assignable to anything
 * — and such an implementation never produces a promise to attach a handler to. `.catch()` on the
 * result therefore catches rejections and misses throws, which is the one case where the cleanup
 * fault escapes and becomes the answer the client sees instead of the refusal.
 */
async function abandon(source: BoundedBodySource): Promise<void> {
  try {
    await source.discard();
  } catch {
    // Deliberately swallowed: see above.
  }
}

/**
 * The length a caller declared, or `undefined` when it declared none — or declared something that is
 * not a length.
 *
 * A malformed or absent header is deliberately NOT a refusal on its own. `content-length` is a hint
 * here and never the bound, so a caller that forges one is still bounded by the read; answering 400
 * to a header nobody has to send would only break the chunked uploads it was meant to protect.
 */
function declaredLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Percent-decodes one captured path parameter.
 *
 * Returns `undefined` for malformed encoding (`decodeURIComponent` throws on a lone `%`) instead of
 * propagating an exception out of routing, and `undefined` for a decoded value that regains a path
 * separator or resolves to a traversal step. Capturing raw and decoding here is what stops
 * `%2e%2e%2f` from being one thing to the authorization check and another to the handler.
 */
export function decodeParameter(raw: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return undefined;
  if (decoded === '.' || decoded === '..') return undefined;
  return decoded;
}
