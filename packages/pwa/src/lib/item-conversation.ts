/**
 * WHAT WAS SAID ABOUT ONE AGENDA ITEM, read through the session messages route — so the Inbox item's History
 * shows the owner's replies and the ferret's answers like the chat does, without opening the conversation.
 *
 * The route reads forward from the start, so the whole conversation is walked (the route's own page ceiling).
 * Kept, as the chat's own `TranscriptEntry`: every user and assistant row that names the item (`!A47`), and the
 * assistant rows that answer a kept user row (up to the next user row) — the ferret seldom repeats the reference
 * in its reply. `itemHistory` then applies the one relevance rule to them, exactly as it does to the live chat.
 */

import type { IFyApiClient, SessionTranscriptMessage } from '@ferretry/protocol';
import type { TranscriptEntry } from './session-screens.ts';

export type ItemConversationClient = Pick<IFyApiClient, 'messages'>;

const PAGE = 1_000;
/** How many pages one read walks before it stops. */
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

/** The rows of one conversation about `itemId`, oldest first. */
export const readItemConversation = async (
  client: ItemConversationClient,
  sessionId: string,
  itemId: string,
): Promise<readonly TranscriptEntry[]> => {
  const named = new RegExp(`(?:^|[^\\w])!${itemId}(?![\\w])`, 'u');
  const kept: TranscriptEntry[] = [];
  let cursor: string | undefined;
  let seen = 0;
  // A user row about the item opens its answer: the assistant rows after it are kept until the next user row.
  let answering = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await client.messages(sessionId, cursor, PAGE);
    for (const message of read.messages) {
      seen += 1;
      const entry = entryOf(message, seen);
      if (entry === null) continue;
      const about = named.test(message.text);
      if (entry.kind === 'user') answering = about;
      if (about || (entry.kind === 'assistant' && answering)) kept.push(entry);
    }
    if (read.nextCursor === null) break;
    cursor = read.nextCursor;
  }
  return kept;
};
