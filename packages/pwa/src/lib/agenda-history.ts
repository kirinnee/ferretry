/**
 * THE HISTORY OF ONE AGENDA ITEM, read off the two places that hold it: the item's own revisions (what the
 * ferret or the owner changed) and the conversation (what the owner said about it, what the ferret answered).
 * Pure: the item view draws it, newest last, like the chat it replaces.
 *
 * The owner's messages are read with the protocol's one reader (`parseAgendaMessage`) — never a pattern of
 * ours — so an answer, a reply and a discussion are the forms the daemon wrote. A ferret message belongs to the
 * item when it names it as a `!A47` reference.
 */

import { type AgendaItem, type AgendaMessagePart, parseAgendaMessage } from '@ferretry/protocol';
import { type RevisionEntry, revisionList } from './agenda-revisions.ts';
import type { TranscriptEntry } from './session-screens.ts';

/** The longest ferret message kept whole; the rest is cut and marked, the chat holds the whole. */
export const HISTORY_FERRET_CHARS = 700;

export type HistoryEvent =
  | { readonly kind: 'raised'; readonly key: string; readonly at: number; readonly by: AgendaItem['raisedBy'] }
  | { readonly kind: 'revision'; readonly key: string; readonly at: number; readonly entry: RevisionEntry }
  | { readonly kind: 'owner'; readonly key: string; readonly at: number; readonly part: AgendaMessagePart }
  | {
      readonly kind: 'owner-text';
      readonly key: string;
      readonly at: number;
      readonly text: string;
      /** The chat's own row for what the owner said, so History draws it with the chat's own message component. */
      readonly entry: TranscriptEntry;
    }
  | {
      readonly kind: 'ferret';
      readonly key: string;
      readonly at: number;
      readonly text: string;
      readonly entry: TranscriptEntry;
    };

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
      return mentions(entry.text, id)
        ? [{ kind: 'owner-text', key: entry.id, at: clock, text: entry.text, entry }]
        : [];
    }
    if (entry.kind === 'assistant' && mentions(entry.text, id)) {
      const text = cut(entry.text);
      return [{ kind: 'ferret', key: entry.id, at: clock, text, entry: { ...entry, text } }];
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

/** The words a message starts with, spaces folded: two reads of one message share it, whatever one of them cut. */
const stem = (text: string): string => text.replace(/\s+/gu, ' ').trim().replace(/…$/u, '').slice(0, 80);

/** What the ferret said lately as the chat's own rows; the ids are the reader's, never the chat's. */
export const recentEntries = (
  messages: readonly { readonly text: string; readonly timestamp?: string }[],
): readonly TranscriptEntry[] =>
  messages.map((message, order) => {
    const at = Date.parse(message.timestamp ?? '');
    return {
      id: `recent:${order}`,
      kind: 'assistant',
      text: message.text,
      ...(Number.isFinite(at) ? { at } : {}),
    };
  });

/** What the ferret said lately without naming the item: the lead-up to it. One the item's own reading holds is not drawn twice. */
const lately = (recent: readonly TranscriptEntry[], held: readonly HistoryEvent[]): readonly HistoryEvent[] => {
  const known = new Set(held.flatMap(event => (event.kind === 'ferret' ? [stem(event.text)] : [])));
  return recent
    .filter(entry => !known.has(stem(entry.text)))
    .map((entry): HistoryEvent => {
      const text = cut(entry.text);
      return { kind: 'ferret', key: entry.id, at: entry.at ?? 0, text, entry: { ...entry, text } };
    });
};

/**
 * The item's revisions and the conversation about it, oldest first: the item view reads top-down, newest last. The
 * item's own events (raised, edited) are small dividers between the bubbles; the bubbles are what was said — the
 * rows that name the item, and the ferret's last few messages (`recent`) that led up to it.
 */
export const itemHistory = (
  item: AgendaItem,
  entries: readonly TranscriptEntry[],
  recent: readonly TranscriptEntry[] = [],
): readonly HistoryEvent[] => {
  const said = spoken(item.id, entries);
  const events = [...revisions(item), ...said, ...lately(recent, said)];
  if (events.length === 0) return events;
  const raised: HistoryEvent = {
    kind: 'raised',
    key: 'raised',
    at: Date.parse(item.waitingSince) || 0,
    by: item.raisedBy,
  };
  return [raised, ...events]
    .map((event, order) => ({ event, order }))
    .sort((a, b) => a.event.at - b.event.at || a.order - b.order)
    .map(({ event }) => event);
};
