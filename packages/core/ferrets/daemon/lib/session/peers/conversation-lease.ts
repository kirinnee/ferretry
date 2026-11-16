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
  /**
   * Moves the lease of the conversation `command` names off this daemon's own pid onto the PANE's `pid` (the process
   * the pane runs, read after it opened). A pane the daemon launches never runs the runtime wrapper, so nothing else
   * ever does: left on the daemon's pid, the lease reads as dead to a terminal claim the moment the daemon restarts while
   * the pane is still writing. Throws when it cannot — no pid, or another writer holds the conversation — and the caller
   * stops the pane (fail closed). Nothing to do for a command that names no conversation.
   */
  moveToPane(sessionId: string, command: readonly string[], pid: number | undefined): Promise<void>;
  release(sessionId: string): Promise<void>;
}
