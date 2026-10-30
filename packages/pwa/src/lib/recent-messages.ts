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

/** Why "Last messages" could not be shown: a short reason for the reader, and the raw text for a tooltip. */
export interface RecentFailure {
  readonly reason: string;
  readonly raw: string;
}

const NETWORK_WORDS = /failed to fetch|network|load failed|unreachable|offline|econn|socket|timed? ?out/iu;

/**
 * Maps whatever the read threw to a few plain words — never the daemon's own sentence, which is for an
 * operator. Known daemon refusals get their own reason; a lost connection says the machine was not
 * reached; anything else is a generic short reason. The raw text is kept for `title`.
 */
export const describeRecentFailure = (error: unknown): RecentFailure => {
  const raw = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const status = (error as { readonly status?: unknown } | null)?.status;
  const code = (error as { readonly code?: unknown } | null)?.code;
  const reason =
    code === 'transcript_unreadable' || /proved transcript this daemon could not read completely/iu.test(raw)
      ? "part of this conversation couldn't be read yet (it may still be being written, or it is too large)"
      : name === 'FyTransportError' || NETWORK_WORDS.test(raw)
        ? "couldn't reach the machine"
        : status === 401 || status === 403
          ? "this device isn't allowed to read it"
          : status === 404
            ? 'the conversation is no longer there'
            : 'something went wrong reading it';
  return { reason, raw };
};
