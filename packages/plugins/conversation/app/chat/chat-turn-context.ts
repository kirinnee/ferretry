/**
 * THE CHAT'S OWN READING OF WHOSE TURN IT IS, offered to the panels the chat page draws around itself (the toolbar's
 * turn word). The chat's refresh already reads the ferret and the observer's prompt, serialises those reads, and is
 * nudged on every ferret change; a panel that asks the daemon again would be a second poll that can disagree with the
 * conversation beside it, or land an older answer late. So the page says what it last read, and the panel draws that.
 *
 * A COMPACTION is the one thing here that is not a read: it exists only on the live event frame the page's stream
 * carries, so the page nests a second reading over the toolbar that adds `compacting` from its latest live sample.
 */
import { createContext, useContext } from 'react';
import type { ChatSessionState } from './chat-session.ts';

export interface ChatTurn {
  /** The ferret this reading is of. */
  readonly ferret: string;
  /** The turn as the chat last read it; absent for a ferret that is stopped, starting, unread or not observed. */
  readonly turnState: ChatSessionState['turnState'];
  /** Whether the ferret's live sample says a compaction is running. Absent: the page has no live sample to say. */
  readonly compacting?: boolean;
}

export const ChatTurnContext = createContext<ChatTurn | null>(null);

/** Whether the chat on screen for `ferret` is told a compaction is running. */
export function useChatCompacting(ferret: string | undefined): boolean {
  const reading = useContext(ChatTurnContext);
  return ferret !== undefined && reading?.ferret === ferret && reading.compacting === true;
}

/** The chat's reading of `ferret`'s turn, or `undefined` when no chat of that ferret is above this panel. */
export function useChatTurn(ferret: string | undefined): ChatSessionState['turnState'] {
  const reading = useContext(ChatTurnContext);
  return ferret !== undefined && reading?.ferret === ferret ? reading.turnState : undefined;
}

/** The reading the page above was handed, to be nested over with more (the page's live sample); `null` when there is none. */
export const useChatTurnReading = (): ChatTurn | null => useContext(ChatTurnContext);
