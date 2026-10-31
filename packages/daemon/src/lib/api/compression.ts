import type { ApiRequest, ApiResponse } from './http.ts';

/**
 * RESPONSE COMPRESSION: which answers are gzipped, and the one rule that keeps it from leaking.
 *
 * A fleet list is ~1.7 MB and the board ~0.9 MB, and both compress ten- and five-fold. Every carrier
 * profits — a phone on cellular and a relay that meters bytes most of all — so the decision is made
 * ONCE, here, by the dispatcher, and the transports only carry the bytes it produced: the direct HTTP
 * adapter as a `Content-Encoding: gzip` body, the session tunnel as a base64 body under the same
 * header (`docs/relay-protocol.md` §14, "A compressed answer"). Compression therefore happens BEFORE
 * any sealing: the bytes a relay's channel encrypts are already the compressed ones.
 *
 * THE RULE: AN ANSWER IS NEVER COMPRESSED UNLESS ITS ROUTE WAS AUDITED AND SAYS SO (`compress: true`).
 * Compression before encryption makes a record's length depend on its content, and a response that
 * mixes a secret — a token, a digest of one, a pairing code, input-request material — with anything a
 * caller can influence is the BREACH shape: an observer who sees sizes and can steer the reflected
 * text learns the secret a byte at a time. The default is therefore off, because a list of routes that
 * must not be compressed is wrong the day a route is added and nobody remembers to add it to the list.
 * The defences stack, and each stands alone:
 *
 * - only a route that opted in is compressed, and the set of them is pinned in the route table's own
 *   tests, so adding one is a visible, reviewed change;
 * - only `GET` answers — every credential this daemon mints (a pairing code, a device token, a socket
 *   ticket, a secret write) is the answer to a `POST`;
 * - only `200` JSON over {@link COMPRESS_MIN_BYTES}, so a short answer — which is what a credential
 *   always is — is never touched.
 *
 * Terminal output is a separate case with a separate answer, in §14: a stream is never compressed.
 */

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
    !response.headers.has('content-encoding') &&
    (response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json') &&
    response.body.length >= COMPRESS_MIN_BYTES
  );
}

/**
 * The answer, with a gzip form attached when the caller asked for one and it is worth sending.
 *
 * `body` stays the plain text: everything that reads an answer other than a transport (an etag, a test,
 * an audit) still sees what the route said. The transport that sends `gzip` adds `Content-Encoding`.
 * An answer the caller did not ask to have compressed still carries `Vary: Accept-Encoding`, so a
 * cache between the two never hands the gzip form to a caller that cannot read it.
 */
export async function compressed(
  request: ApiRequest,
  response: ApiResponse,
  compressor: ResponseCompressor | undefined,
  optedIn: boolean,
): Promise<ApiResponse> {
  if (compressor === undefined || !eligible(request, response, optedIn)) return response;
  const headers = addVary(response.headers);
  if (request.headers.has('range') || !acceptsGzip(request.headers.get('accept-encoding')))
    return { ...response, headers };
  const gzip = await compressor.gzip(response.body);
  return gzip.byteLength < response.body.length ? { ...response, headers, gzip } : { ...response, headers };
}
