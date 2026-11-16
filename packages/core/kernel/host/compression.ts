/**
 * RESPONSE COMPRESSION: which answers are gzipped, and the one rule that keeps it from leaking (copied from today's
 * `packages/daemon/src/lib/api/compression.ts`).
 *
 * The decision is made ONCE, by the dispatcher, and the transports only carry the bytes it produced: the direct HTTP
 * adapter as a `Content-Encoding: gzip` body, the session tunnel as a base64url body under the same header
 * (`docs/relay-protocol.md` §14). Compression therefore happens BEFORE any sealing.
 *
 * THE RULE: AN ANSWER IS NEVER COMPRESSED UNLESS ITS ROUTE WAS AUDITED AND SAYS SO (`compress: true`). Compression
 * before encryption makes a record's length depend on its content (BREACH), so the default is off, and the defences
 * stack: only an opted-in route, only `GET` (every credential is a `POST` answer), only `200` JSON of at least
 * {@link COMPRESS_MIN_BYTES}, never a `guard: 'secrets'` answer, and never a stream.
 */
import type { ApiRequest, ApiResponse } from '../contract/http.ts';

/** Below this a gzip header and a thread hop cost more than they save. */
export const COMPRESS_MIN_BYTES = 8 * 1024;

/** What turns text into gzip bytes. A port because the codec is a runtime's, not the domain's. */
export interface ResponseCompressor {
  gzip(text: string): Promise<Uint8Array>;
}

/** Whether `Accept-Encoding` admits gzip: named without `q=0`, or admitted by `*` and not refused by name. */
export function acceptsGzip(acceptEncoding: string | undefined): boolean {
  if (acceptEncoding === undefined) return false;
  let named: boolean | undefined;
  let wildcard = false;
  for (const entry of acceptEncoding.split(',')) {
    const [coding = '', ...parameters] = entry.trim().toLowerCase().split(';');
    const weight = parameters
      .map(parameter => parameter.trim())
      .find(parameter => parameter.startsWith('q='))
      ?.slice(2);
    const allowed = weight === undefined ? true : Number(weight) > 0;
    if (coding.trim() === 'gzip' || coding.trim() === 'x-gzip') named = allowed;
    else if (coding.trim() === '*') wildcard = allowed;
  }
  return named ?? wildcard;
}

function addVary(headers: ReadonlyMap<string, string>): Map<string, string> {
  const next = new Map(headers);
  const vary = next.get('vary');
  if (vary === undefined) next.set('vary', 'Accept-Encoding');
  else if (!vary.split(',').some(value => ['accept-encoding', '*'].includes(value.trim().toLowerCase())))
    next.set('vary', `${vary}, Accept-Encoding`);
  return next;
}

/** Whether this answer is one the policy would compress for SOME caller: the part a cache must key on. */
function eligible(request: ApiRequest, response: ApiResponse, optedIn: boolean): boolean {
  return (
    optedIn &&
    request.method === 'GET' &&
    response.status === 200 &&
    response.late === undefined &&
    !response.headers.has('content-encoding') &&
    (response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json') &&
    response.body.length >= COMPRESS_MIN_BYTES
  );
}

/**
 * The answer, with a gzip form attached when the caller asked for one and it is worth sending. `body` stays the plain
 * text (an etag, a test, an audit still see what the route said). An eligible answer the caller did not ask to have
 * compressed still carries `Vary: Accept-Encoding`, so a cache never hands the gzip form to a caller that cannot read
 * it. `undefined` gzip in the result = send plain.
 */
export async function compressed(
  request: ApiRequest,
  response: ApiResponse,
  compressor: ResponseCompressor | undefined,
  optedIn: boolean,
): Promise<{ readonly response: ApiResponse; readonly gzip?: Uint8Array }> {
  if (compressor === undefined || !eligible(request, response, optedIn)) return { response };
  const headers = addVary(response.headers);
  const varied = { ...response, headers };
  if (request.headers.has('range') || !acceptsGzip(request.headers.get('accept-encoding'))) return { response: varied };
  const gzip = await compressor.gzip(response.body);
  return gzip.byteLength < response.body.length ? { response: varied, gzip } : { response: varied };
}
