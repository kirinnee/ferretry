/**
 * PEER: today's `packages/daemon/src/lib/warden/types.ts` (owner: warden) — the one label the session provenance
 * code reads. A copy of its own: the observer helper's `peers/warden.ts` is a separate file.
 *
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the
 * host.
 */

/** Label that marks a fleet-warden session. Warden sessions — and everything
 *  they spawn — are excluded from every anomaly class so a warden can never
 *  escalate against itself. */
export const WARDEN_LABEL = 'fleet-warden';
