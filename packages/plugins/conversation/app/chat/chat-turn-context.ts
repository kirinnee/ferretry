/**
 * THE CHAT'S OWN READING OF WHOSE TURN IT IS, offered to the panels the chat page draws around itself (the toolbar's
 * turn word). The chat's refresh already reads the ferret and the observer's prompt, serialises those reads, and is
 * nudged on every ferret change; a panel that asks the daemon again would be a second poll that can disagree with the
 * conversation beside it, or land an older answer late. So the page says what it last read, and the panel draws that.
 */
import { createContext, useContext } from 'react';
import type { ChatSessionState } from './chat-session.ts';

export interface ChatTurn {
  /** The ferret this reading is of. */
  readonly ferret: string;
  /** The turn as the chat last read it; absent for a ferret that is stopped, starting, unread or not observed. */
  readonly turnState: ChatSessionState['turnState'];
}

export const ChatTurnContext = createContext<ChatTurn | null>(null);

/** The chat's reading of `ferret`'s turn, or `undefined` when no chat of that ferret is above this panel. */
export function useChatTurn(ferret: string | undefined): ChatSessionState['turnState'] {
  const reading = useContext(ChatTurnContext);
  return ferret !== undefined && reading?.ferret === ferret ? reading.turnState : undefined;
}
