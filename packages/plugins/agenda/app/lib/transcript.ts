/**
 * THE CHAT'S ROWS, as far as the Agenda reads them. The transcript and the send ledger are Conversation's; the
 * Agenda never reads them itself (the ask screen mounts Conversation's own panel in the `agenda.conversation` slot).
 * A host that has the chat's rows may still hand an item view the ones about the item (`readConversation`), and
 * these are the fields the item's History reads of them: structural, so any host's rows fit.
 */

/** A send's record in the chat's ledger: its id and how far it got. */
export interface LedgerSendRecord {
  readonly sendId: string;
  readonly fate: string;
  readonly acceptedAt?: string;
  readonly message?: string;
  readonly held?: true;
  readonly withdrawn?: true;
}

/** One row of the chat. */
export interface TranscriptEntry {
  readonly id: string;
  readonly kind: 'user' | 'assistant' | 'tool' | 'command' | 'notice' | 'system' | 'ledger';
  readonly text: string;
  readonly at?: number;
  readonly label?: string;
  /** Another ferret sent this row: it is never the owner's. */
  readonly peer?: unknown;
  /** The delivered send a `user` row is. */
  readonly send?: LedgerSendRecord;
}
