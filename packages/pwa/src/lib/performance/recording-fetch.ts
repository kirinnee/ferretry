/**
 * EVERY DAEMON REQUEST, TIMED WHERE IT LEAVES THE APP.
 *
 * Wrapped around the carrier's `fetch` in the composition root, beneath both the typed client and the
 * stores that read without it, and beneath the joining of identical reads (`shared-reads.ts`) — so what
 * is counted is what actually went to a daemon, once, however many surfaces asked.
 *
 * The caller is never slowed for it: the answer is handed back the moment it arrives, and its size
 * is counted afterwards from a copy, chunk by chunk, without ever joining the chunks into one buffer.
 */

import type { DaemonFetch } from '../runtime-models.ts';
import type { PerformanceRecorder, RequestOutcome } from './recorder.ts';
import { routePattern } from './route-pattern.ts';

/** UTF-8 length of a string, counted rather than encoded, so a large body is not copied to be measured. */
const utf8Length = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      // A surrogate pair is one four-byte character.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};

/** What a request body weighs, for the bodies this app sends; a stream or a form is not measured. */
export const bodyBytes = (body: BodyInit | null | undefined): number => {
  if (body === null || body === undefined) return 0;
  if (typeof body === 'string') return utf8Length(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof URLSearchParams) return utf8Length(body.toString());
  return 0;
};

/** The size of an answer's body, read from a copy without assembling it. */
const responseBytes = async (response: Response): Promise<number> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0) return declared;
  const body = response.clone().body;
  if (body === null) return 0;
  const reader = body.getReader();
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return bytes;
    bytes += chunk.value.byteLength;
  }
};

const requestUrl = (input: string | URL | Request): string => (input instanceof Request ? input.url : input.toString());

const requestMethod = (input: string | URL | Request, init: RequestInit | undefined): string =>
  init?.method ?? (input instanceof Request ? input.method : 'GET');

/** `send`, with every request it makes recorded on `recorder` by route pattern. */
export const recordingFetch =
  (send: DaemonFetch, recorder: PerformanceRecorder): DaemonFetch =>
  async (input, init) => {
    const route = routePattern(requestMethod(input, init), requestUrl(input));
    const bytesOut = bodyBytes(init?.body);
    const at = recorder.clock.now();
    const failure = (outcome: RequestOutcome): void =>
      recorder.recordRequest({ route, at, durationMs: recorder.clock.now() - at, outcome, bytesIn: 0, bytesOut });
    let response: Response;
    try {
      response = await send(input, init);
    } catch (error) {
      failure(init?.signal?.aborted === true ? 'aborted' : 'failed');
      throw error;
    }
    const durationMs = recorder.clock.now() - at;
    void responseBytes(response).then(
      bytesIn => recorder.recordRequest({ route, at, durationMs, outcome: response.status, bytesIn, bytesOut }),
      () => recorder.recordRequest({ route, at, durationMs, outcome: response.status, bytesIn: 0, bytesOut }),
    );
    return response;
  };
