import type { Arrival, SessionPrincipal } from './session.ts';

export type ApiHeaders = ReadonlyMap<string, string>;
export type QueryParameters = ReadonlyMap<string, readonly string[]>;
/** Path parameters, RAW. Decode with {@link decodeParameter}. */
export type RouteParameters = ReadonlyMap<string, string>;

/**
 * One call as the kernel hands it to admission and a handler. Today's `ApiRequest`, field for field, except:
 * `loopback`, `privilegedLoopback` and `carrier` are one {@link Arrival} only the kernel's listener can make local,
 * and `device` / `member` are one kernel-stamped {@link SessionPrincipal} (there is no device or member bearer).
 */
export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly query: QueryParameters;
  readonly headers: ApiHeaders;
  /** Told the matched route's declared `METHOD template`, for metrics; never called for a call that matched none. */
  readonly onRoute?: (route: string) => void;
  readonly clientAddress?: string;
  readonly arrival: Arrival;
  /** Present only on a sealed session whose mode verified a holder; stamped by the kernel. */
  readonly principal?: SessionPrincipal;
  /** The session transcript hash a step-up assertion is bound to. */
  readonly transcriptHash?: Uint8Array;
  /**
   * The build of the daemon answering this call (its version, the `x-ferretry-version` it stamps), stamped by the
   * dispatcher and never read from the wire. A conditional tag folds it in ({@link tagForBuild}).
   */
  readonly build?: string;
  readonly signal?: AbortSignal;
  readonly text: (limitBytes?: number) => Promise<string>;
}

/** Arrived through the kernel's own listener. "Local" can come from nowhere else (§7.1). */
export function arrivedLocal(request: ApiRequest): boolean {
  return request.arrival.kind === 'local';
}

/** Today's `arrivedOnHost`: the admin token, through the local listener. */
export function arrivedOnHost(request: ApiRequest, adminToken: boolean): boolean {
  return adminToken && arrivedLocal(request);
}

/** Today's `arrivedPrivileged`: the privileged local listener, or the admin token on the host. */
export function arrivedPrivileged(request: ApiRequest, adminToken: boolean): boolean {
  return (request.arrival.kind === 'local' && request.arrival.privileged) || arrivedOnHost(request, adminToken);
}

declare const publishedBrand: unique symbol;

/**
 * A response after its final check: frozen, with no `late`. Only the kernel's `publishResponse` makes one; a carrier
 * turns only this into bytes.
 */
export interface PublishedApiResponse extends ApiResponse {
  readonly late?: never;
  readonly [publishedBrand]: true;
}

/**
 * Today's `ApiResponse`, unchanged (§7.3). `late` is the synchronous final check: every carrier calls
 * {@link finalised} as its last synchronous step before turning a response into bytes. For a `guard: 'secrets'` route
 * the dispatcher attaches a `late` that only CHOOSES between the already-masked body and the fixed withheld sentence,
 * from `OutputGuard` state. No await, no vault, no masking in `late`.
 */
export interface ApiResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
  readonly late?: () => PlainApiResponse | PublishedApiResponse;
  readonly gzip?: Uint8Array;
  /**
   * A BINARY BODY: the answer's bytes, with `body` left empty. A listener sends them as they are; the session wire
   * carries them as unpadded base64url under `content-transfer-encoding: base64url` (and no `content-encoding`), which
   * is how the app tells them from a gzip answer. Only a route that serves a file (a picture, a clip) sets one, through
   * {@link bytesResponse}; every other answer is text.
   */
  readonly bytes?: Uint8Array;
  /** The sealed session ends after this response (a revoke of the caller's own device). */
  readonly endsSession?: true;
}

export interface PlainApiResponse extends ApiResponse {
  readonly gzip?: never;
}

/** The final check: the response as it may leave now. Synchronous; carriers call it last. */
export function finalised(response: ApiResponse): ApiResponse {
  return response.late === undefined ? response : response.late();
}

export interface ApiValidationIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** Thrown by a handler for an ordinary refusal; the dispatcher turns it into {@link errorResponse}. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly validationIssues?: readonly ApiValidationIssue[],
    readonly extra?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** A JSON body. The kernel adds the version header when it publishes; a handler never sets it. */
export function jsonResponse(
  value: unknown,
  status = 200,
  extra: Readonly<Record<string, string>> = {},
): PlainApiResponse {
  const headers = new Map<string, string>([['content-type', JSON_CONTENT_TYPE]]);
  for (const [name, headerValue] of Object.entries(extra)) headers.set(name.toLowerCase(), headerValue);
  return { status, headers, body: JSON.stringify(value) };
}

export function textResponse(body: string, status = 200, contentType = 'text/plain; charset=utf-8'): PlainApiResponse {
  return { status, headers: new Map([['content-type', contentType]]), body };
}

/** A binary body (see {@link ApiResponse.bytes}). `headers` are lowercased here; `content-type` is the caller's to name. */
export function bytesResponse(
  bytes: Uint8Array,
  contentType: string,
  status = 200,
  extra: Readonly<Record<string, string>> = {},
): PlainApiResponse {
  const headers = new Map<string, string>([['content-type', contentType]]);
  for (const [name, headerValue] of Object.entries(extra)) headers.set(name.toLowerCase(), headerValue);
  return { status, headers, body: '', bytes };
}

/** The error envelope every JSON failure uses: `{ error, code }`. */
export function errorResponse(
  status: number,
  message: string,
  code?: string,
  extra: Readonly<Record<string, unknown>> = {},
): PlainApiResponse {
  return jsonResponse(code === undefined ? { ...extra, error: message } : { ...extra, error: message, code }, status);
}

export function headersFrom(entries: Readonly<Record<string, string>>): ApiHeaders {
  return new Map(Object.entries(entries).map(([name, value]) => [name.toLowerCase(), value]));
}

export function queryFrom(entries: Iterable<readonly [string, string]>): QueryParameters {
  const query = new Map<string, string[]>();
  for (const [key, value] of entries) {
    const existing = query.get(key);
    if (existing === undefined) query.set(key, [value]);
    else existing.push(value);
  }
  return query;
}

export function headerValue(request: ApiRequest, name: string): string | undefined {
  return request.headers.get(name.toLowerCase());
}

export function queryValues(request: ApiRequest, name: string): readonly string[] {
  return request.query.get(name) ?? [];
}

export function queryValue(request: ApiRequest, name: string): string | undefined {
  return queryValues(request, name)[0];
}

/** Decodes one raw path parameter; refuses separators, NUL, `.` and `..`. */
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

/**
 * Whether an `If-None-Match` names this tag. A GET compares weakly (RFC 9110 §13.1.2), so a `W/` prefix is ignored,
 * and `*` names any tag.
 */
export function namesTag(ifNoneMatch: string, etag: string): boolean {
  return ifNoneMatch
    .split(',')
    .map(candidate => candidate.trim())
    .some(candidate => candidate === '*' || candidate.replace(/^W\//u, '') === etag);
}

/**
 * Names the daemon build in a strong tag: `"v"` becomes `"<build>.v"`. A tag is made from what a store holds, but the
 * body is made by the build, so a client that held the tag across a daemon upgrade (an app survives a reconnect) must
 * not be answered `304` onto the old build's body. No build named leaves the tag as it was.
 */
export function tagForBuild(tag: string, build: string | undefined): string {
  if (build === undefined) return tag;
  const inner = tag.startsWith('"') && tag.endsWith('"') && tag.length >= 2 ? tag.slice(1, -1) : tag;
  return `"${build}.${inner}"`;
}

/**
 * The tag a route serves and the verdict on the request's `If-None-Match`, for a route that answers conditionally
 * without {@link answerWhenChanged} (its tag comes with the body, or its 304 keeps headers of its own): the build is
 * folded in here, in the one place, so no route names it itself.
 */
export function conditionalTag(request: ApiRequest, tag: string): { readonly etag: string; readonly held: boolean } {
  const etag = tagForBuild(tag, request.build);
  const asked = headerValue(request, 'if-none-match');
  return { etag, held: asked !== undefined && namesTag(asked, etag) };
}

/**
 * A CONDITIONAL GET WHOSE TAG IS KNOWN BEFORE THE BODY EXISTS. `tag` is the strong, quoted validator the caller derived
 * from a version the store already holds (a file identity, a ledger revision) — never from the body — so a request that
 * names it is answered `304` with no body and `build` is never called: an unchanged poll costs a stat, not a read, a
 * serialisation and an encryption. Anything else is the built answer with the tag on it.
 *
 * The tag must be read BEFORE the body is built: a change in between then leaves the body newer than its tag, and the
 * next poll is one needless full answer, never a stale `304`.
 *
 * The daemon build the dispatcher stamped on the request is part of the tag (see {@link tagForBuild}), so every route
 * that answers here names the build without remembering to.
 *
 * Only a `200` carries the tag; a built refusal is returned as it came.
 */
export async function answerWhenChanged(
  request: ApiRequest,
  tag: string,
  build: () => Promise<ApiResponse>,
): Promise<ApiResponse> {
  const { etag, held } = conditionalTag(request, tag);
  if (held) return { status: 304, headers: new Map([['etag', etag]]), body: '' };
  const built = await build();
  if (built.status !== 200) return built;
  const headers = new Map(built.headers);
  headers.set('etag', etag);
  return { ...built, headers };
}
