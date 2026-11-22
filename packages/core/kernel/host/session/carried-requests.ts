import type { ApiRequest } from '../../contract/http.ts';
import type { SessionPrincipal } from '../../contract/session.ts';
import { type CarriedOrigin, type RecordRequestSource, sessionApiRequest } from './wire/index.ts';

/**
 * THE REQUESTS A SESSION CARRIES, AND WHEN THEIR CALLER LEAVES.
 *
 * Every request a session builds carries one signal of its own: aborted when the session ends (the peer left, the
 * lease ended, the session was closed: a queued apply sees the caller left) AND when that request settles (its handler
 * answered or failed, {@link settled}). A session has no per-request cancel record, so the session's end is the only
 * way a carried caller can leave; the settle is the request's own end, and a standing admitted for it (a spent
 * step-up) must not outlive it while the session stays open. The signal is per request, never shared: one request
 * settling ends nobody else's.
 */
export class CarriedRequests {
  readonly #ended = new AbortController();
  readonly #own = new WeakMap<ApiRequest, AbortController>();

  /** The kernel's own request for one carried request, carrying the session's end and its own settle as its signal. */
  build(
    source: RecordRequestSource,
    principal: SessionPrincipal,
    origin: CarriedOrigin,
    transcriptHash?: Uint8Array,
  ): ApiRequest {
    const own = new AbortController();
    const request = sessionApiRequest(
      source,
      principal,
      origin,
      transcriptHash,
      AbortSignal.any([this.#ended.signal, own.signal]),
    );
    this.#own.set(request, own);
    return request;
  }

  /** The request's handler has settled (answered or failed): its signal aborts, the session's other requests go on. */
  settled(request: ApiRequest): void {
    this.#own.get(request)?.abort();
  }

  /** Whatever the session's requests still run or wait for belongs to a caller that is gone. */
  end(): void {
    this.#ended.abort();
  }
}
