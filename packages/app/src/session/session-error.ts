/**
 * Thrown for every refusal this side makes or is told about, carrying the close code.
 *
 * `endedWhileServing` is true only when the session had already accepted this device and was serving requests when it
 * ended. It is what lets the client layer tell a `4440` that raced another request's `endsSession` (no outcome for THIS
 * request: a carrier-style loss) from a `4440` before acceptance, which §14 calls a protocol violation.
 */
export class RelaySessionError extends Error {
  /**
   * `true` on a failure delivered to a request whose head record NEVER LEFT this browser (it was still queued, or the
   * session had already ended): the one clean proof the daemon never saw it, so sending it again is safe, any method.
   */
  readonly neverSent: boolean;
  constructor(
    message: string,
    readonly code: number,
    readonly endedWhileServing: boolean = false,
    neverSent: boolean = false,
  ) {
    super(message);
    this.neverSent = neverSent;
    this.name = 'RelaySessionError';
  }
}

/** The same failure, for a request that provably never left: same code, same words, `neverSent` set. */
export function neverSentCopy(failure: RelaySessionError): RelaySessionError {
  return new RelaySessionError(failure.message, failure.code, failure.endedWhileServing, true);
}

/** Said to every session a new carrier preference closes. The router OWNS the fence; the transport only reads it. */
export const PREFERENCE_CHANGED_REASON = 'the connection preference for this machine changed';
/** Said to every session an unpair or a re-pair closes. */
export const PAIRING_CLEARED_REASON = 'this daemon was re-paired or unpaired';
/** Said to a walk whose entry a republish replaced while it was in flight. */
export const STALE_WALK_REASON =
  'this daemon was re-paired, unpaired or republished, or its connection preference changed, while this request was in flight, so it was not carried to another carrier';

const FENCE_REASONS: ReadonlySet<string> = new Set([
  PREFERENCE_CHANGED_REASON,
  PAIRING_CLEARED_REASON,
  STALE_WALK_REASON,
]);

/**
 * Whether a session failure is the carrier router's own FENCE: it closed (code `1000`) a session or refused a walk
 * because the pairing, the preference or the published set changed under it. That is a decision about this daemon, not
 * a carrier that died, so the same request walked again meets the same refusal.
 */
export function isFenceRefusal(failure: RelaySessionError): boolean {
  return failure.code === 1000 && FENCE_REASONS.has(failure.message);
}
