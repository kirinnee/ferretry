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
    request.action === 'compact' ? null : (request.effort ?? null),
    request.action === 'model' ? (request.model ?? null) : null,
  ]);
}
