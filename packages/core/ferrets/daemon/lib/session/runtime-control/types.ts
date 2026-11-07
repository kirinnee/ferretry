/**
 * The vocabulary of changing what a RUNNING session is running.
 *
 * The refusal taxonomy lives here rather than beside the HTTP routes because it is a domain fact:
 * "the harness cannot express this" and "the same request id already happened" are true whether the
 * caller arrived over HTTP, over a relay, or from a future CLI. The mount keeps the one thing that
 * genuinely is its own — which status and code each refusal answers with.
 *
 * Every port below is narrow on purpose. The composition root holds a session storage adapter, a
 * tmux controller, a pane delivery adapter and a picker transport; none of those belong in a domain
 * decision, and a service that took them could not be unit tested without dragging the adapters
 * tier into the unit coverage ledger.
 */

import type { RuntimeControlRequest } from '../../protocol/session.ts';

/** Why a runtime read or control could not be served. */
export type SessionRuntimeFailure =
  /** The path or the request names something unusable. */
  | 'invalid'
  /** No such session. */
  | 'not_found'
  /** The session's own condition refuses it: the wrong lifecycle window, a busy pane, a picker quarantine. */
  | 'refused'
  /** The harness cannot express what was asked — a level it has no command for, a model it does not
   *  advertise. A different request could succeed, which is what separates it from `refused`. */
  | 'unsupported'
  /** The live catalog could not be read, so no targeted switch can be planned against it. */
  | 'catalog_unavailable'
  /** The same request id was already spent on a DIFFERENT control. */
  | 'conflict'
  /**
   * The same request id was durably begun, and whether it reached the harness or how that attempt
   * ended was never recorded.
   *
   * DISTINCT FROM `conflict`, because the caller did nothing wrong and there is nothing to correct in
   * the request. Repeating it is the danger — the first `/compact` may already have discarded
   * context — so the honest answer is "the pane may have been touched; go and look" rather than a
   * replayed success the daemon cannot vouch for or a retry it must not perform.
   */
  | 'unsettled'
  /** It was attempted, and the attempt failed. */
  | 'failed';

/** A refusal raised by the runtime control service, in a taxonomy the mount can map to HTTP. */
export class SessionRuntimeError extends Error {
  constructor(
    readonly failure: SessionRuntimeFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionRuntimeError';
  }
}

/**
 * The daemon-private startup half of the runtime service.
 *
 * The caller already owns the process-wide mutation fence for this session. Keeping that fact in a
 * separate capability instead of a boolean on the mounted subsystem makes a nested, non-reentrant
 * queue acquisition impossible to request through the public API.
 */
export interface SessionRuntimeStartupHeldPort {
  startupWhileHeld(sessionId: string, request: RuntimeControlRequest, requestId: string): Promise<void>;
}
