/**
 * THE SLOTS CONVERSATION'S CHAT OFFERS (§5.2; lead decisions Q3/Q4). A plugin contributes a panel to one with
 * `panel(CONVERSATION_ROW_SLOT, { id })`; the chat mounts every panel contributed there once per transcript row, with
 * the row's entry in its props and the ferret as its `subject`. Conversation imports nothing of a contributor.
 *
 *   - `conversation.row` ........ beside a row of the transcript; the panel sees only {id, kind, text, at?, label?}, no tool calls.
 *   - `conversation.row-actions`  in an assistant message's footer: Voice offers "Read aloud" on the message.
 */

export const CONVERSATION_ROW_SLOT = 'conversation.row' as const;
export const CONVERSATION_ROW_ACTIONS_SLOT = 'conversation.row-actions' as const;

/** Every slot the chat offers, in one list a test can pair against the panels other plugins contribute. */
export const CONVERSATION_SLOTS = [CONVERSATION_ROW_SLOT, CONVERSATION_ROW_ACTIONS_SLOT] as const;
export type ConversationSlot = (typeof CONVERSATION_SLOTS)[number];

/**
 * The transcript row a panel is drawn for, as far as a contributor may rely on it. The chat hands ONLY these fields (the
 * rest of its row stays inside Conversation), built from the daemon's reading of this ferret's transcript: the words are
 * the daemon's redacted text, so a value Vault masks is masked here too. A row that exists only on this device (a send
 * that has not landed, or was refused) has not been through the daemon, so it is never offered to a slot.
 */
export interface ConversationRowEntry {
  readonly id: string;
  readonly kind: 'user' | 'assistant' | 'tool' | 'command' | 'notice' | 'system';
  readonly text: string;
  /** Epoch milliseconds of the row's first record, when known. */
  readonly at?: number;
  readonly label?: string;
}

/** The props every panel in a Conversation slot receives, beside its `subject` (the ferret). */
export interface ConversationRowProps {
  readonly entry: ConversationRowEntry;
}
