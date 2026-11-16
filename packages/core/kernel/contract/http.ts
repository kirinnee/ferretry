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
  /** Told the matched route template, for metrics. */
  readonly onRoute?: (template: string) => void;
  readonly clientAddress?: string;
  readonly arrival: Arrival;
  /** Present only on a sealed session whose mode verified a holder; stamped by the kernel. */
  readonly principal?: SessionPrincipal;
  /** The session transcript hash a step-up assertion is bound to. */
  readonly transcriptHash?: Uint8Array;
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
