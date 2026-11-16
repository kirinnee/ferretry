/**
 * The launch's port for conversation leases (docs/design/account-model.md H2, §9.3): what `FerretsService.launch` — the ONE
 * place every pane opens (`fy new`, a resume, a Warden revive, a restart, a move's relaunch, a lifecycle start) — needs to
 * keep one live writer per harness conversation. The rules and the files are the contract's and the daemon's
 * (`lib/session/lifecycle/conversation-leases.ts`); this is only the seam Ferrets is handed, with no global to reach for.
 */
import type { FerretId } from '../../../contract/index.ts';

export interface FerretLaunchLeases {
  /**
   * Claims `conversation` for `ferret` as this daemon, BEFORE any pane exists. Throws `ConversationLeaseHeldError` when
   * another live writer holds it: the daemon never takes a held conversation. The same ferret claiming again renews.
   */
  claimConversation(ferret: FerretId, conversation: string): Promise<void>;
  /**
   * The same ferret claiming again, now as the pane's own process (a renewal under the pool's lock): a terminal's claim
   * reads the pid, so the lease must name the pane's and not a daemon that may restart while the pane keeps writing.
   * Throws when another writer holds the conversation, or when `pid` is unknown (the caller then stops the pane).
   */
  moveConversationToPane(ferret: FerretId, conversation: string, pid: number | undefined): Promise<void>;
  /** Frees every conversation `ferret` holds. */
  release(ferret: FerretId): Promise<void>;
}
