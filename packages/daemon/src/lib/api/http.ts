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
  /** Whether the peer is on the loopback interface. Query-parameter tokens are honoured only for
   *  loopback peers, so a token can never travel in a loggable URL across a network hop. */
  readonly loopback: boolean;
  /** Reads the body as text. Lazy so a route that needs no body never pays to buffer one. */
  readonly text: () => Promise<string>;
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
