/**
 * THE OWNER'S CHAT, as `fy agenda log` reads it: the messages the owner sent THIS session, from the session's own
 * message store. The ferret never retypes the owner's words; the daemon copies them from here.
 */

/** One message the owner sent, its words as they typed them (a chat reply's `[re !A5 …]` heading is not theirs). */
export interface OwnerChatMessage {
  /** The id the message has in the session's queue and send ledger. */
  readonly messageId: string;
  readonly at: string;
  readonly text: string;
}

export type OwnerChatLookup =
  | { readonly ok: true; readonly message: OwnerChatMessage }
  /** `none`: the owner sent nothing; `unknown`: no such message in this session; `not-owner`: it is not the owner's. */
  | { readonly ok: false; readonly reason: 'none' | 'unknown' | 'not-owner' };

export interface OwnerChat {
  /** The owner's latest message to the session, or the one with `messageId`. Total: an unreadable store is `none`/`unknown`. */
  find(sessionId: string, messageId?: string): Promise<OwnerChatLookup>;
}

/** No chat store: nothing can be logged. */
export const NO_OWNER_CHAT: OwnerChat = {
  find: async (_session, messageId) => ({ ok: false, reason: messageId === undefined ? 'none' : 'unknown' }),
};
