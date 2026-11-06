import type { ApiResponse } from './http.ts';

/** Private state makes the type nominal: spreading a publication cannot keep its proof. */
class ResponsePublication implements ApiResponse {
  readonly #headers: ReadonlyMap<string, string>;
  readonly status: number;
  readonly body: string;
  declare readonly headers: ReadonlyMap<string, string>;
  declare readonly gzip?: Uint8Array;
  declare readonly late?: never;
  readonly endsSession?: true;

  constructor(response: ApiResponse) {
    this.#headers = new Map(response.headers);
    this.status = response.status;
    this.body = response.body;
    if (response.endsSession !== undefined) this.endsSession = response.endsSession;
    Object.defineProperty(this, 'headers', { enumerable: true, get: () => new Map(this.#headers) });
    // Buffer is a Uint8Array too, but Buffer.slice() aliases its source rather than copying it.
    const gzip = response.gzip === undefined ? undefined : new Uint8Array(response.gzip);
    if (gzip !== undefined) Object.defineProperty(this, 'gzip', { enumerable: true, get: () => gzip.slice() });
    Object.freeze(this);
  }
}

/** A source-owned wire generation. Only publishResponse can construct one. */
export type PublishedApiResponse = ResponsePublication;

export function isPublishedResponse(response: ApiResponse): response is PublishedApiResponse {
  return response instanceof ResponsePublication;
}

/**
 * Publish after a source changes, then return this SAME generation from its late reader until the
 * next change. Containers are private copies; even edits through a returned map or byte array cannot
 * alter the publication. Republishing after an in-place source edit invalidates the old generation.
 */
export function publishResponse(response: ApiResponse): PublishedApiResponse {
  return new ResponsePublication(response);
}
