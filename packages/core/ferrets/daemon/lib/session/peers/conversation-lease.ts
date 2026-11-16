/**
 * The launch path's port for conversation leases: what the session lifecycle needs to claim a conversation before a pane
 * exists and to free it once the session is over.
 *
 * The rules (what makes a lease stale, which argv names which conversation, the refusal sentence) are the contract's
 * (`contract/conversation-lease.ts`), shared with `fy history claim`; the daemon's binding is
 * `daemon/lib/session/lifecycle/conversation-leases.ts` over `daemon/adapters/session/lifecycle/conversation-lease-disk.ts`,
 * composed by the root and handed to the session files.
 */

/** INJECTED: what a launch path needs — claim before a pane exists, release once the session is over. */
export interface SessionConversationLeases {
  /** Throws `ConversationLeaseHeldError` when another live writer holds the conversation. */
  claim(sessionId: string, command: readonly string[]): Promise<void>;
  release(sessionId: string): Promise<void>;
}
