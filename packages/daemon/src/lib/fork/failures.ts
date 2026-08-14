/**
 * Why a fork refused, as CODES rather than as prose a caller has to pattern-match.
 *
 * A route mount needs to map each refusal onto a wire failure and an HTTP status, and it must be
 * able to do that without re-deriving the reason from a message string. So every refusal here
 * carries a `failure` code, and the codes are the whole closed set this layer can produce. The wire
 * schema that names them lives in `@ferretry/protocol` and is not invented here: one fact, one
 * owner, and a daemon-side copy of a protocol enum is a second owner.
 *
 * There is deliberately NO terminal-failure state on the durable receipt. A fork touches nothing
 * that cannot be redone: it never writes to, stops, restamps or journals its source, and every step
 * after the receipt is claimed is bound to the fresh target and idempotent. So a step that failed
 * is simply re-driven on the next attempt, and a step that fails deterministically refuses
 * identically every time — which is the honest answer. Compare a migration, whose failures must be
 * remembered precisely because it destroys a pane before it relaunches one.
 */

import { type SessionForkKey, sessionForkKey } from './identity.ts';

export type SessionForkFailure = 'request_conflict' | 'receipt_invalid' | 'phase_regression';

/** The one type a caller has to catch, carrying the code it has to switch on. */
export class SessionForkError extends Error {
  constructor(
    readonly failure: SessionForkFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionForkError';
  }
}

/**
 * One `(source, request id)` pair was presented with two different payloads.
 *
 * Answering the second with the first's result would tell a caller that its fork through message
 * 900 into `codex` succeeded when what exists is a fork through message 40 into `claude`. That is
 * worse than any error, so neither fork is performed and the caller is told the id is spent.
 */
export class SessionForkRequestConflictError extends SessionForkError {
  constructor(readonly key: SessionForkKey) {
    super(
      'request_conflict',
      `${sessionForkKey(key)} is already bound to a different fork payload: one source and request id name exactly one fork`,
    );
    this.name = 'SessionForkRequestConflictError';
  }
}

/**
 * A durable receipt could not be read as one.
 *
 * The receipt is the only thing standing between a lost response and a second session, so a
 * document that no longer parses — or one the store answered with for a key nobody asked about — is
 * refused rather than replaced. Minting a fresh receipt over an unreadable one is exactly how a
 * retry creates a second target for a fork that already has one.
 */
export class SessionForkReceiptInvalidError extends SessionForkError {
  constructor(
    readonly key: SessionForkKey,
    readonly detail: string,
  ) {
    super('receipt_invalid', `the durable fork receipt for ${sessionForkKey(key)} is not usable: ${detail}`);
    this.name = 'SessionForkReceiptInvalidError';
  }
}

/**
 * A phase was asked to move backwards or sideways.
 *
 * This is a defect in this daemon, not a caller error, and it is raised rather than tolerated
 * because the phase is what makes a restart safe: a receipt that could regress would let a replay
 * re-run a boundary the fork has already passed.
 */
export class SessionForkPhaseRegressionError extends SessionForkError {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(
      'phase_regression',
      `a fork receipt at ${from} cannot advance to ${to}: the phase is monotonic, so it only ever moves forward`,
    );
    this.name = 'SessionForkPhaseRegressionError';
  }
}
