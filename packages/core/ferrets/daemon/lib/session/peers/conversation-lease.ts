/**
 * PEER: today's `packages/daemon/src/lib/session/conversation-lease.ts` (owner: conversation) — the launch path's
 * port only. The leases themselves (`ConversationLeases`, over the fleet's shared lease store) stay the
 * conversation plugin's.
 *
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the
 * host.
 */

/** INJECTED: what a launch path needs — claim before a pane exists, release once the session is over. */
export interface SessionConversationLeases {
  /** Throws when another live writer holds the conversation. */
  claim(sessionId: string, command: readonly string[]): Promise<void>;
  release(sessionId: string): Promise<void>;
}
