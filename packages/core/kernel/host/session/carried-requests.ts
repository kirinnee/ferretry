import type { ApiRequest } from '../../contract/http.ts';
import type { SessionPrincipal } from '../../contract/session.ts';
import { type CarriedOrigin, type RecordRequestSource, sessionApiRequest } from './wire/index.ts';

/**
 * THE REQUESTS A SESSION CARRIES, AND WHEN THEIR CALLER LEAVES.
 *
 * Every request a session builds carries one signal, aborted when the session ends (the peer left, the lease ended,
 * the session was closed): a queued apply sees the caller left. A session has no per-request cancel record, so its
 * end is the only way a carried caller can leave.
 */
export class CarriedRequests {
  readonly #ended = new AbortController();

  /** The kernel's own request for one carried request, carrying the session's end as its signal. */
  build(
    source: RecordRequestSource,
    principal: SessionPrincipal,
    origin: CarriedOrigin,
    transcriptHash?: Uint8Array,
  ): ApiRequest {
    return sessionApiRequest(source, principal, origin, transcriptHash, this.#ended.signal);
  }

  /** Whatever the session's requests still run or wait for belongs to a caller that is gone. */
  end(): void {
    this.#ended.abort();
  }
}
