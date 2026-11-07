/**
 * PEER: today's `packages/daemon/src/lib/session/send/types.ts` (owner: conversation) — the one status set the
 * runtime-control policy reads. A copy of its own: the observer helper's `peers/send.ts` is a separate file.
 *
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the
 * host.
 */
import type { SessionStatus } from '../../protocol/session.ts';

/**
 * The three the resume domain calls terminal, for its reason: nothing is monitoring whatever pane
 * survived, so a message typed there is simply lost. A send to one of these becomes a revive.
 */
export const TERMINAL_SEND_STATUSES: ReadonlySet<SessionStatus> = new Set(['failed', 'stopped', 'completed']);
