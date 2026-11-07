/**
 * The kernel's proof that a response was finalised (`publishResponse`), checked by the session wire before it turns
 * an answer into records. Kept here, beside the wire, so the browser-safe session graph never reaches into the host.
 */
import type { ApiResponse, PublishedApiResponse } from '../../../contract/http.ts';

/** Private state makes the type nominal: spreading a publication cannot keep its proof (today's `ResponsePublication`). */
class ResponsePublication {
  readonly #headers: ReadonlyMap<string, string>;
  readonly status: number;
  readonly body: string;
  declare readonly headers: ReadonlyMap<string, string>;
  declare readonly gzip?: Uint8Array;
  readonly endsSession?: true;

  constructor(response: ApiResponse) {
    this.#headers = new Map(response.headers);
    this.status = response.status;
    this.body = response.body;
    if (response.endsSession !== undefined) this.endsSession = response.endsSession;
    Object.defineProperty(this, 'headers', { enumerable: true, get: () => new Map(this.#headers) });
    const gzip = response.gzip === undefined ? undefined : new Uint8Array(response.gzip);
    if (gzip !== undefined) Object.defineProperty(this, 'gzip', { enumerable: true, get: () => gzip.slice() });
    Object.freeze(this);
  }
}

export function isPublishedResponse(response: ApiResponse): response is PublishedApiResponse {
  return response instanceof ResponsePublication;
}

/** Only the kernel makes a published response; a carrier turns only a finalised response into bytes. */
export function publishResponse(response: ApiResponse): PublishedApiResponse {
  return new ResponsePublication(response) as unknown as PublishedApiResponse;
}
