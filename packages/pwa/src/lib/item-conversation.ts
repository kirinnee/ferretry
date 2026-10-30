/**
 * WHAT WAS SAID ABOUT ONE AGENDA ITEM, read through the session messages route — so the Inbox item's History
 * shows the owner's replies and the ferret's answers like the chat does, without opening the conversation.
 *
 * The route reads forward from the start, so the whole conversation is walked (the route's own page ceiling)
 * and only the user and assistant rows that name the item (`!A47`) are kept as the chat's own `TranscriptEntry`.
 */

import type { IFyApiClient, SessionTranscriptMessage } from '@ferretry/protocol';
import type { TranscriptEntry } from './session-screens.ts';

export type ItemConversationClient = Pick<IFyApiClient, 'messages'>;

const PAGE = 1_000;
/** How many pages one read walks before it stops: the same bound as the recent-messages read. */
const MAX_PAGES = 40;

const entryOf = (message: SessionTranscriptMessage, index: number): TranscriptEntry | null => {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const at = message.timestamp === undefined ? Number.NaN : Date.parse(message.timestamp);
  return {
    id: `${message.point.byteOffset}:${message.point.blockIndex ?? index}`,
    kind: message.role,
    text: message.text,
    ...(Number.isFinite(at) ? { at } : {}),
  };
};

/** The user and assistant rows of one conversation that name `itemId`, oldest first. */
export const readItemConversation = async (
  client: ItemConversationClient,
  sessionId: string,
  itemId: string,
): Promise<readonly TranscriptEntry[]> => {
  const named = `!${itemId}`;
  const kept: TranscriptEntry[] = [];
  let cursor: string | undefined;
  let seen = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await client.messages(sessionId, cursor, PAGE);
    for (const message of read.messages) {
      seen += 1;
      if (!message.text.includes(named)) continue;
      const entry = entryOf(message, seen);
      if (entry !== null) kept.push(entry);
    }
    if (read.nextCursor === null) break;
    cursor = read.nextCursor;
  }
  return kept;
};
