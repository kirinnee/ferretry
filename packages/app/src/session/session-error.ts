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
