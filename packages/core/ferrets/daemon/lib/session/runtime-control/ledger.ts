/** The stable identity of one parsed runtime request, stored by the shared durable effect ledger. */

import type { RuntimeControlRequest } from '@ferretry/protocol';

/**
 * The control itself, in its parsed form.
 *
 * Two bodies that differ only in key order or whitespace are the same request, and a retry may well
 * re-serialize them — so the comparison is over the fields the union actually carries rather than
 * over the bytes that arrived.
 */
export function runtimeRequestFingerprint(request: RuntimeControlRequest): string {
  return JSON.stringify([
    request.action,
    request.action === 'model' || request.action === 'effort' ? (request.effort ?? null) : null,
    request.action === 'model' ? (request.model ?? null) : null,
    // Appended only for fast mode, so the fingerprint of every other control — including one begun
    // before this existed and still awaiting a retry — is unchanged.
    ...(request.action === 'fast' ? [request.fast] : []),
  ]);
}
