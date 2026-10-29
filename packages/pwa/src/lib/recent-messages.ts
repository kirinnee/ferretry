/**
 * THE LAST FEW THINGS A FERRET SAID, read through the session messages route — so the Attention page can
 * show what led up to an item without opening the whole conversation.
 *
 * The route reads FORWARD only, from the start of the conversation, so the tail is found by walking to
 * the end. A walk is remembered per conversation: the next read starts from the cursor of the last page
 * it read (the route answers a re-asked cursor with that page and anything appended since), so opening
 * the same item twice reads one page, not the whole conversation again.
 */

import type { IFyApiClient, SessionTranscriptMessage } from '@ferretry/protocol';

/** One message the ferret wrote, as the page shows it: words only. */
export interface RecentMessage {
  readonly text: string;
  readonly timestamp?: string;
}

export type MessagesClient = Pick<IFyApiClient, 'messages'>;

/** How many rows one request asks for: the route's own ceiling. */
const RECENT_PAGE = 1_000;
/** How many of the ferret's last messages the Attention page shows. */
export const RECENT_MESSAGE_COUNT = 3;
/** How many pages one read walks before it gives up on reaching the end. */
const RECENT_MAX_PAGES = 40;

/** Where a remembered walk resumes: the cursor of its last page, and what it had found before that page. */
interface Walk {
  readonly from: string | undefined;
  readonly before: readonly RecentMessage[];
}

const said = (message: SessionTranscriptMessage): RecentMessage | null => {
  if (message.role !== 'assistant') return null;
  const text = message.text.trim();
  if (text === '') return null;
  return message.timestamp === undefined ? { text } : { text, timestamp: message.timestamp };
};

/**
 * Reads the last `count` messages a ferret wrote, oldest first. `memory` keeps each conversation's walk
 * between reads (key it by machine and session); a fresh map reads from the start.
 */
export const readRecentMessages = async (
  client: MessagesClient,
  sessionId: string,
  count: number,
  memory: Map<string, Walk> = new Map(),
  memoryKey = sessionId,
): Promise<readonly RecentMessage[]> => {
  const held = memory.get(memoryKey);
  let cursor = held?.from;
  let kept: readonly RecentMessage[] = held?.before ?? [];
  for (let page = 0; page < RECENT_MAX_PAGES; page += 1) {
    const read = await client.messages(sessionId, cursor, RECENT_PAGE);
    const found = read.messages.map(said).filter((message): message is RecentMessage => message !== null);
    const through = [...kept, ...found].slice(-count);
    if (read.nextCursor === null) {
      memory.set(memoryKey, { from: cursor, before: kept });
      return through;
    }
    kept = through;
    cursor = read.nextCursor;
  }
  memory.set(memoryKey, { from: cursor, before: kept });
  return kept;
};

export type RecentMessagesMemory = Map<string, Walk>;
