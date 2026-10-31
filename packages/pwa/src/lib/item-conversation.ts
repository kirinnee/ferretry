/**
 * WHAT WAS SAID ABOUT ONE AGENDA ITEM, read through the session messages route — so the Inbox item's History
 * shows the owner's replies and the ferret's answers like the chat does, without opening the conversation.
 *
 * The thread is read from the TAIL: the newest page first, then older ones, until a row older than the item
 * (`since`) is in hand — nobody can name `!A47` before it exists, so nothing further back can belong to it. A
 * recent item costs one page instead of the whole conversation (a long lead session was 12 pages, 9.5 MB).
 * A machine that does not offer backward reads (`DAEMON_FEATURES.messagesTail`) is walked forward from the start
 * as before, up to the route's page ceiling.
 *
 * Kept, as the chat's own `TranscriptEntry`: every user and assistant row that names the item (`!A47`), and the
 * assistant rows that answer a kept user row (up to the next user row) — the ferret seldom repeats the reference
 * in its reply. `itemHistory` then applies the one relevance rule to them, exactly as it does to the live chat.
 */

import {
  type AgendaItem,
  DAEMON_FEATURES,
  hasFeature,
  type IFyApiClient,
  type SessionTranscriptMessage,
} from '@ferretry/protocol';
import type { TranscriptEntry } from './session-screens.ts';

export type ItemConversationClient = Pick<IFyApiClient, 'health' | 'messages' | 'messagesTail'>;

/** Rows per page when reading from the tail: the route's own default, so a recent item is one small read. */
const TAIL_PAGE = 200;
/** Rows per page when walking forward (the route's ceiling). */
const FORWARD_PAGE = 1_000;
/** How many pages one forward read walks before it stops. */
const MAX_FORWARD_PAGES = 40;
/** How many pages one tail read walks back: the same number of rows the forward walk could reach. */
const MAX_TAIL_PAGES = (MAX_FORWARD_PAGES * FORWARD_PAGE) / TAIL_PAGE;
/** Slack under the item's earliest known instant: the clock a row was stamped with is not the item's. */
const FLOOR_SLACK_MS = 60 * 60 * 1_000;

/**
 * The instant before which no row can be about the item, or `undefined` when none is known. The item carries
 * no raise time of its own, so this is its earliest instant it does carry, less an hour: `waitingSince` is the
 * raise unless the item was woken from a snooze, and a daemon may stamp it earlier than the add.
 */
export const itemSince = (item: AgendaItem): number | undefined => {
  const instants = [
    item.waitingSince,
    item.askedAt,
    ...(item.history ?? []).map(entry => entry.at),
    ...(item.revisions ?? []).map(revision => revision.at),
  ]
    .map(at => (at === undefined ? Number.NaN : Date.parse(at)))
    .filter(Number.isFinite);
  return instants.length === 0 ? undefined : Math.min(...instants) - FLOOR_SLACK_MS;
};

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

/** Feeds rows oldest first and keeps the ones that belong to the item's thread. */
const threadOf = (itemId: string) => {
  const named = new RegExp(`(?:^|[^\\w])!${itemId}(?![\\w])`, 'u');
  const kept: TranscriptEntry[] = [];
  let seen = 0;
  // A user row about the item opens its answer: the assistant rows after it are kept until the next user row.
  let answering = false;
  return {
    kept,
    feed: (messages: readonly SessionTranscriptMessage[]): void => {
      for (const message of messages) {
        seen += 1;
        const entry = entryOf(message, seen);
        if (entry === null) continue;
        const about = named.test(message.text);
        if (entry.kind === 'user') answering = about;
        if (about || (entry.kind === 'assistant' && answering)) kept.push(entry);
      }
    },
  };
};

const offersTail = async (client: ItemConversationClient): Promise<boolean> => {
  try {
    return hasFeature(await client.health(), DAEMON_FEATURES.messagesTail);
  } catch {
    return false;
  }
};

const olderThan = (messages: readonly SessionTranscriptMessage[], since: number): boolean =>
  messages.some(message => message.timestamp !== undefined && Date.parse(message.timestamp) < since);

const readFromTail = async (
  client: ItemConversationClient,
  sessionId: string,
  since: number | undefined,
): Promise<readonly SessionTranscriptMessage[]> => {
  const newestFirst: (readonly SessionTranscriptMessage[])[] = [];
  let through: string | undefined;
  for (let page = 0; page < MAX_TAIL_PAGES; page += 1) {
    const read = await client.messagesTail(sessionId, {
      limit: TAIL_PAGE,
      ...(through === undefined ? {} : { through }),
    });
    newestFirst.push(read.messages);
    if (read.previousCursor === null || read.previousCursor === undefined) break;
    if (since !== undefined && olderThan(read.messages, since)) break;
    through = read.previousCursor;
  }
  return newestFirst.reverse().flat();
};

/** The rows of one conversation about `itemId`, oldest first. `since`: see {@link itemSince}. */
export const readItemConversation = async (
  client: ItemConversationClient,
  sessionId: string,
  itemId: string,
  since?: number,
): Promise<readonly TranscriptEntry[]> => {
  const thread = threadOf(itemId);
  if (await offersTail(client)) {
    thread.feed(await readFromTail(client, sessionId, since));
    return thread.kept;
  }
  let cursor: string | undefined;
  for (let page = 0; page < MAX_FORWARD_PAGES; page += 1) {
    const read = await client.messages(sessionId, cursor, FORWARD_PAGE);
    thread.feed(read.messages);
    if (read.nextCursor === null) break;
    cursor = read.nextCursor;
  }
  return thread.kept;
};
