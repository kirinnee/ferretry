/**
 * THE HISTORY OF ONE AGENDA ITEM: the conversation ABOUT it, and nothing else. Pure: the item view draws it under the
 * card, newest last, like a chat.
 *
 * WHAT COUNTS AS "ABOUT THIS ITEM" (the relevance rule):
 *
 * - THE OWNER: a user-channel row that is an agenda form naming this item (read with the protocol's one reader,
 *   `parseAgendaMessage` — never a pattern of ours), or a plain message that cites `!A47`. The composer under an
 *   open item always prefixes that reference, so every reply typed there qualifies. A row another ferret sent
 *   (`peer`) is never the owner's.
 * - THE FERRET: (a) its FINAL text of the turn that answers one of those owner rows — the last assistant text before
 *   the next user row, so the narration between tool calls is left out; and (b) any assistant text that cites
 *   `!A47` itself. Only assistant TEXT: tool calls, thinking, commands and notices are other row kinds and are never
 *   read. What it said about anything else, however recent, is not this item's history.
 * - THE ITEM ITSELF: one "Card updated to vN" line per edit. Its raise is the ferret's own message citing it (b);
 *   nothing is made up to stand for it, so the card's words are never said twice.
 */

import { type AgendaItem, type AgendaMessagePart, parseAgendaMessage } from '@ferretry/protocol';
import type { TranscriptEntry } from './session-screens.ts';

/** The longest ferret message kept whole; the rest is cut and marked, the chat holds the whole. */
export const HISTORY_FERRET_CHARS = 700;

export type HistoryEvent =
  /** An edit made the card version `version`. */
  | { readonly kind: 'revision'; readonly key: string; readonly at: number; readonly version: number }
  /** The owner's own words to the item: an answer, a note, a reply. */
  | {
      readonly kind: 'owner';
      readonly key: string;
      readonly at: number;
      readonly text: string;
      /** The answer form it was sent as; absent for a plain reply. */
      readonly form?: AgendaMessagePart['kind'];
      readonly note?: string;
    }
  /** What the ferret said to the item. */
  | { readonly kind: 'ferret'; readonly key: string; readonly at: number; readonly text: string };

const citesPattern = (id: AgendaItem['id']): RegExp => new RegExp(`(?:^|[^\\w])!${id}(?![\\w])`, 'u');

const cut = (text: string): string =>
  text.length > HISTORY_FERRET_CHARS ? `${text.slice(0, HISTORY_FERRET_CHARS).trimEnd()}…` : text;

/** A plain reply without the reference the composer put in front of it: the bubble says what the owner typed. */
const withoutLeadingReference = (text: string, id: AgendaItem['id']): string => {
  const stripped = text.replace(new RegExp(`^\\s*!${id}(?![\\w])[\\s:,—-]*`, 'u'), '');
  return stripped.trim() === '' ? text.trim() : stripped.trim();
};

/** The words an answer form's bubble says when the owner added none of their own. */
const FORM_WORDS: Readonly<Record<AgendaMessagePart['kind'], string>> = {
  answer: '',
  done: 'Done',
  dismissed: 'Not needed',
  'needs-info': 'Need more info',
  discuss: 'Let’s talk this through',
  re: '',
};

/** The owner's bubble for one agenda form. */
const ownerPart = (part: AgendaMessagePart): { readonly text: string; readonly note?: string } => {
  const text = part.text.trim();
  if (part.kind === 'dismissed') return { text: FORM_WORDS.dismissed, ...(text === '' ? {} : { note: text }) };
  return {
    text: text === '' ? FORM_WORDS[part.kind] : text,
    ...(part.note === undefined || part.note.trim() === '' ? {} : { note: part.note.trim() }),
  };
};

/** What the owner said to the item in one user row, or nothing when the row is not about it. */
const ownerSaid = (entry: TranscriptEntry, id: AgendaItem['id'], at: number): readonly HistoryEvent[] => {
  if (entry.peer !== undefined) return [];
  const message = parseAgendaMessage(entry.text);
  if (message !== undefined) {
    return message.parts
      .filter(part => part.items.some(named => named.id === id))
      .map(
        part => ({ kind: 'owner', key: `${entry.id}:${part.raw}`, at, form: part.kind, ...ownerPart(part) }) as const,
      )
      .filter(event => event.text !== '');
  }
  return citesPattern(id).test(entry.text)
    ? [{ kind: 'owner', key: entry.id, at, text: withoutLeadingReference(entry.text, id) }]
    : [];
};

/** The conversation's rows about one item, in the order they were said. */
const spoken = (id: AgendaItem['id'], entries: readonly TranscriptEntry[]): readonly HistoryEvent[] => {
  const cites = citesPattern(id);
  const events: HistoryEvent[] = [];
  let clock = 0;
  // The ferret's turn that answers an owner row about this item: its last text wins.
  let answering = false;
  let reply: HistoryEvent | null = null;
  const closeTurn = (): void => {
    if (reply !== null) events.push(reply);
    reply = null;
  };
  for (const entry of entries) {
    clock = entry.at ?? clock;
    if (entry.kind === 'user') {
      closeTurn();
      const said = ownerSaid(entry, id, clock);
      events.push(...said);
      answering = said.length > 0;
      continue;
    }
    if (entry.kind !== 'assistant' || entry.text.trim() === '') continue;
    const text = cut(entry.text.trim());
    const event: HistoryEvent = { kind: 'ferret', key: entry.id, at: clock, text };
    if (cites.test(entry.text)) {
      // Said about the item in so many words: kept whatever turn it is in, and it ends the turn's pending reply.
      if (answering) reply = null;
      events.push(event);
    } else if (answering) {
      reply = event;
    }
  }
  closeTurn();
  return events;
};

const versions = (item: AgendaItem): readonly HistoryEvent[] =>
  (item.revisions ?? []).map(
    (revision, index) =>
      ({
        kind: 'revision',
        key: `revision:${revision.at}:${String(index)}`,
        at: Date.parse(revision.at) || 0,
        version: index + 2,
      }) as const,
  );

/**
 * The item's history, oldest first: the item view reads top-down, newest last. Empty when nothing was said about the
 * item and it was never edited.
 */
export const itemHistory = (item: AgendaItem, entries: readonly TranscriptEntry[]): readonly HistoryEvent[] =>
  [...versions(item), ...spoken(item.id, entries)]
    .map((event, order) => ({ event, order }))
    .sort((a, b) => a.event.at - b.event.at || a.order - b.order)
    .map(({ event }) => event);
