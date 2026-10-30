/**
 * THE HISTORY OF ONE AGENDA ITEM, read off the two places that hold it: the item's own revisions (what the
 * ferret or the owner changed) and the conversation (what the owner said about it, what the ferret answered).
 * Pure: the item view draws it, newest last, like the chat it replaces.
 *
 * The owner's messages are read with the protocol's one reader (`parseAgendaMessage`) — never a pattern of
 * ours — so an answer, a reply and a discussion are the forms the daemon wrote. A ferret message belongs to the
 * item when it names it as a `!A47` reference.
 */

import { type AgendaMessagePart, type AgendaItem, parseAgendaMessage } from '@ferretry/protocol';
import { type RevisionEntry, revisionList } from './agenda-revisions.ts';
import type { TranscriptEntry } from './session-screens.ts';

/** The longest ferret message kept whole; the rest is cut and marked, the chat holds the whole. */
export const HISTORY_FERRET_CHARS = 700;

export type HistoryEvent =
  | { readonly kind: 'revision'; readonly key: string; readonly at: number; readonly entry: RevisionEntry }
  | { readonly kind: 'owner'; readonly key: string; readonly at: number; readonly part: AgendaMessagePart }
  | { readonly kind: 'owner-text'; readonly key: string; readonly at: number; readonly text: string }
  | { readonly kind: 'ferret'; readonly key: string; readonly at: number; readonly text: string };

const mentions = (text: string, id: AgendaItem['id']): boolean =>
  new RegExp(`(?:^|[^\\w])!${id}(?![\\w])`, 'u').test(text);

const cut = (text: string): string =>
  text.length > HISTORY_FERRET_CHARS ? `${text.slice(0, HISTORY_FERRET_CHARS).trimEnd()}…` : text;

/** The conversation's rows about one item, in the order they were said. */
const spoken = (id: AgendaItem['id'], entries: readonly TranscriptEntry[]): readonly HistoryEvent[] => {
  let clock = 0;
  return entries.flatMap((entry): readonly HistoryEvent[] => {
    clock = entry.at ?? clock;
    if (entry.kind === 'user') {
      const message = parseAgendaMessage(entry.text);
      if (message !== undefined) {
        return message.parts
          .filter(part => part.items.some(named => named.id === id))
          .map(part => ({ kind: 'owner', key: `${entry.id}:${part.raw}`, at: clock, part }) as const);
      }
      return mentions(entry.text, id) ? [{ kind: 'owner-text', key: entry.id, at: clock, text: entry.text }] : [];
    }
    if (entry.kind === 'assistant' && mentions(entry.text, id)) {
      return [{ kind: 'ferret', key: entry.id, at: clock, text: cut(entry.text) }];
    }
    return [];
  });
};

const revisions = (item: AgendaItem): readonly HistoryEvent[] =>
  [...revisionList(item)].reverse().map(
    entry =>
      ({
        kind: 'revision',
        key: `revision:${entry.at}:${entry.by}`,
        at: Date.parse(entry.at) || 0,
        entry,
      }) as const,
  );

/** The item's revisions and the conversation about it, oldest first: the item view reads top-down, newest last. */
export const itemHistory = (item: AgendaItem, entries: readonly TranscriptEntry[]): readonly HistoryEvent[] =>
  [...revisions(item), ...spoken(item.id, entries)]
    .map((event, order) => ({ event, order }))
    .sort((a, b) => a.event.at - b.event.at || a.order - b.order)
    .map(({ event }) => event);
