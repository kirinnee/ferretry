/**
 * THE STORED CONVERSATION AS THE ITEM VIEW'S PART 6 (docs/agenda.md § The conversation): a machine with
 * `agenda.conversation.1` keeps every word the owner and the ferret said about an item on the item itself, oldest
 * first and whole. This turns those entries into the same events the rebuilt thread draws, so the part reads the same
 * either way. Pure: nothing here reads a clock or the network.
 *
 * THE MAPPING, entry to event:
 *
 * - `by: owner` is the owner's bubble. Its `via` says the form it was sent as: an `answer` is a chosen answer,
 *   `needs-info` and `discuss` are those requests; `reply` and `chat-log` are plain words.
 * - `by: ferret` is the ferret's text. `by: daemon` is Ferretry's own (a closing note, a notice), drawn under its name.
 * - An entry with `fromChat` was copied from the owner's chat by the ferret (`fy agenda log`): it keeps a "from chat"
 *   tag, so the owner knows those words were logged, not typed on the item.
 * - Every entry is kept WHOLE and in the order the daemon stored it.
 */

import type { AgendaConversationEntry, AgendaItem } from '../wire/index.ts';
import { type HistoryEvent, revisionEvents } from './agenda-history.ts';

/** How many entries the item holds in all: its own count, or the tail it carries when the daemon sent no count. */
export const storedCount = (item: Pick<AgendaItem, 'conversation' | 'conversationCount'>): number =>
  item.conversationCount ?? item.conversation?.length ?? 0;

/** Whether the item has stored words at all: an item from before the store reads from the chat instead. */
export const hasStoredConversation = (item: Pick<AgendaItem, 'conversation' | 'conversationCount'>): boolean =>
  storedCount(item) > 0;

/** Whether the tail the item carries is the whole thread: when not, the rest is read through the conversation route. */
export const tailIsWhole = (item: Pick<AgendaItem, 'conversation' | 'conversationCount'>): boolean =>
  (item.conversation?.length ?? 0) >= storedCount(item);

/** The entry words an owner's `via` is drawn as; `undefined` is plain words. */
const OWNER_FORM: Readonly<Partial<Record<AgendaConversationEntry['via'], 'answer' | 'needs-info' | 'discuss'>>> = {
  answer: 'answer',
  'needs-info': 'needs-info',
  discuss: 'discuss',
};

/**
 * One stored entry as the event the part draws. `index` keeps keys unique for words said at the same instant;
 * `answered` says the ferret spoke after it. The owner's words are on the machine (stored on the item). Only words the
 * FERRET logged from the chat (`via: chat-log`) are proof it read them; a chat reply the daemon settled onto the item
 * also carries `fromChat`, but is stored as soon as the queue accepts it, before the ferret has it, so it claims no more
 * than the item.
 */
export const conversationEvent = (entry: AgendaConversationEntry, index: number, answered = false): HistoryEvent => {
  const at = Date.parse(entry.at) || 0;
  const key = `stored:${String(index)}:${entry.at}`;
  const fromChat = entry.fromChat === undefined ? {} : { fromChat: true as const };
  if (entry.by === 'owner') {
    const form = OWNER_FORM[entry.via];
    const logged = entry.via === 'chat-log' && entry.fromChat !== undefined;
    const reached = { via: logged ? ('transcript' as const) : ('item' as const), answered };
    return { kind: 'owner', key, at, text: entry.text, ...(form === undefined ? {} : { form }), ...fromChat, reached };
  }
  return {
    kind: 'ferret',
    key,
    at,
    text: entry.text,
    ...(entry.by === 'daemon' ? { daemon: true as const } : {}),
    ...fromChat,
  };
};

/** Entries of the thread that are not in hand: where they sit in what is drawn, how many, and why. */
export interface ConversationGap {
  /** How many entries of the drawn list come before the gap. */
  readonly at: number;
  readonly count: number;
  readonly state: 'loading' | 'failed' | 'capped';
}

/**
 * The item's history when its words come from the item itself: one event per stored entry, in stored order, and the
 * item's edits for the activity log. The edits are not words anyone said, so the conversation part never draws them.
 * A `gap` puts a line where entries are not in hand, so what is drawn is never passed off as the whole thread.
 */
export const storedHistory = (
  item: AgendaItem,
  conversation: readonly AgendaConversationEntry[],
  gap?: ConversationGap,
): readonly HistoryEvent[] => {
  const lastFerret = conversation.findLastIndex(entry => entry.by === 'ferret');
  const events = conversation.map((entry, index) => conversationEvent(entry, index, index < lastFerret));
  if (gap === undefined || gap.count <= 0) return [...revisionEvents(item), ...events];
  const line: HistoryEvent = { kind: 'gap', key: 'stored:gap', at: 0, earlier: gap.count, state: gap.state };
  return [...revisionEvents(item), ...events.slice(0, gap.at), line, ...events.slice(gap.at)];
};
