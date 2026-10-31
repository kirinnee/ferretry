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
 * - THE FERRET: only the PARTS of its text that are about the item — a paragraph, a list item or a "Q:/A:" recap pair
 *   that cites `!A47`, everything under a heading that cites it, and a recap pair whose Q is the owner's own question
 *   about the item. A lead answers many things in one reply, so the rest of that reply is never this item's history;
 *   a reply with no such part says nothing here (the card itself carries the answer). Only assistant TEXT: tool
 *   calls, thinking, commands and notices are other row kinds and are never read.
 * - THE ITEM ITSELF: one "Card updated to vN" line per edit, with what the edit changed in plain words (the points
 *   added or removed from the premise, context, decided and still-open lists, the fields reworded). Its raise is the
 *   ferret's own message citing it; nothing is made up to stand for it, so the card's words are never said twice.
 */

import { type AgendaItem, type AgendaMessagePart, parseAgendaMessage } from '@ferretry/protocol';
import { FIELD_LABEL, POINT_FIELDS, bulletPoints, describePrevious, itemAtVersion } from './agenda-revisions.ts';
import type { TranscriptEntry } from './session-screens.ts';

/** The longest ferret message kept whole; the rest is cut and marked, the chat holds the whole. */
export const HISTORY_FERRET_CHARS = 700;

export type HistoryEvent =
  /** An edit made the card version `version`. */
  | {
      readonly kind: 'revision';
      readonly key: string;
      readonly at: number;
      readonly version: number;
      /** What the edit changed, in plain words, one line each; empty when nothing readable changed. */
      readonly summary: readonly string[];
    }
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

/** One unit of a reply the way a reader sees it: a heading, a paragraph, a list item or a Q/A recap pair. */
interface Block {
  readonly kind: 'heading' | 'text' | 'pair';
  readonly level: number;
  readonly text: string;
  /** A pair's question alone. */
  readonly question?: string;
}

const HEADING = /^\s{0,3}(#{1,6})\s+\S/u;
const MARKER = /^(\s*)(?:[-*+]|\d+[.)])\s+\S/u;
const QUESTION = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?Q(?:\*\*|__)?:(?:\*\*|__)?\s*(\S.*)$/u;
const ANSWER = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?A(?:\*\*|__)?:(?:\*\*|__)?\s*\S/u;
const FENCE = /^\s*(?:```|~~~)/u;
const indentOf = (line: string): number => line.length - line.trimStart().length;

/** A reply cut into blocks, in order. A fenced code block stays whole inside the block it sits in. */
const blocksOf = (text: string): readonly Block[] => {
  const lines = text.split(/\r?\n/u);
  const blocks: Block[] = [];
  let index = 0;
  const take = (accept: (line: string) => boolean): string[] => {
    const taken: string[] = [];
    let fenced = false;
    while (index < lines.length) {
      const line = lines[index] as string;
      if (FENCE.test(line)) fenced = !fenced;
      if (!fenced && !FENCE.test(line) && !accept(line)) break;
      taken.push(line);
      index += 1;
    }
    return taken;
  };
  const startsBlock = (line: string): boolean =>
    line.trim() === '' || HEADING.test(line) || MARKER.test(line) || QUESTION.test(line) || ANSWER.test(line);
  while (index < lines.length) {
    const line = lines[index] as string;
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: (heading[1] as string).length, text: line.trim() });
      index += 1;
      continue;
    }
    const question = QUESTION.exec(line);
    if (question !== null) {
      const asked = take(next => !ANSWER.test(next) && (next === line || (!startsBlock(next) && next.trim() !== '')));
      const answered = take((next): boolean => next.trim() !== '' && !HEADING.test(next) && !QUESTION.test(next));
      blocks.push({
        kind: 'pair',
        level: 0,
        text: `${asked.join('\n')}\n\n${answered.join('\n')}`,
        question: asked.join(' ').replace(QUESTION, '$1').trim(),
      });
      continue;
    }
    const marker = MARKER.exec(line);
    if (marker !== null) {
      const depth = (marker[1] as string).length;
      const item = take(
        next =>
          next === line ||
          (next.trim() !== '' &&
            !HEADING.test(next) &&
            !QUESTION.test(next) &&
            (indentOf(next) > depth || !MARKER.test(next))),
      );
      blocks.push({ kind: 'text', level: 0, text: item.join('\n') });
      continue;
    }
    const paragraph = take(next => next === line || !startsBlock(next));
    blocks.push({ kind: 'text', level: 0, text: paragraph.join('\n') });
  }
  return blocks;
};

const words = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter(word => word !== ''),
  );

/** Whether a recap's question is the owner's own question, restated: the same words, or nearly. */
const restates = (question: string, owner: string): boolean => {
  const asked = words(question);
  const said = words(owner);
  const least = Math.min(asked.size, said.size);
  if (least < 2) return false;
  let shared = 0;
  for (const word of asked) if (said.has(word)) shared += 1;
  return shared / least >= 0.75;
};

/**
 * The parts of one ferret reply that are about the item: the blocks that cite it, the blocks under a heading that
 * cites it, and the recap pairs whose question is one the owner asked of it. Empty when the reply has none.
 */
const aboutItem = (text: string, cites: RegExp, ownerWords: readonly string[]): string => {
  const kept: string[] = [];
  let section: number | null = null;
  for (const block of blocksOf(text)) {
    if (block.kind === 'heading') {
      const inside = section !== null && block.level > section;
      if (!inside) section = null;
      if (inside || cites.test(block.text)) {
        if (!inside) section = block.level;
        kept.push(block.text);
      }
      continue;
    }
    const inSection = section !== null;
    const pairs = block.kind === 'pair' && ownerWords.some(said => restates(block.question ?? '', said));
    if (inSection || pairs || cites.test(block.text)) kept.push(block.text);
  }
  return kept.join('\n\n');
};

/** The conversation's rows about one item, in the order they were said. */
const spoken = (id: AgendaItem['id'], entries: readonly TranscriptEntry[]): readonly HistoryEvent[] => {
  const cites = citesPattern(id);
  const events: HistoryEvent[] = [];
  const ownerWords: string[] = [];
  let clock = 0;
  for (const entry of entries) {
    clock = entry.at ?? clock;
    if (entry.kind === 'user') {
      const said = ownerSaid(entry, id, clock);
      for (const event of said) if (event.kind === 'owner') ownerWords.push(event.text);
      events.push(...said);
      continue;
    }
    if (entry.kind !== 'assistant' || entry.text.trim() === '') continue;
    const about = aboutItem(entry.text, cites, ownerWords);
    if (about !== '') events.push({ kind: 'ferret', key: entry.id, at: clock, text: cut(about) });
  }
  return events;
};

const LONGEST_POINT = 140;
const MOST_LINES = 6;
const SHOWN_AS_TEXT: ReadonlySet<string> = new Set(['title', 'subject']);

const brief = (text: string): string => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > LONGEST_POINT ? `${flat.slice(0, LONGEST_POINT).trimEnd()}…` : flat;
};

const pointsOf = (text: string | null): readonly string[] =>
  text === null || text.trim() === '' ? [] : (bulletPoints(text) ?? [text.trim()]);

/** What one edit changed, in plain words: bullets added or removed in the list fields, the rest by name. */
const summarize = (item: AgendaItem, index: number): readonly string[] => {
  const revision = item.revisions?.[index];
  if (revision === undefined) return [];
  const after = itemAtVersion(item, index + 2) as unknown as Record<string, unknown>;
  const before = revision.previous as Record<string, unknown>;
  const lines: string[] = [];
  for (const field of revision.changed) {
    const label = FIELD_LABEL[field];
    const was = describePrevious(field, before[field]);
    const now = describePrevious(field, after[field]);
    if (POINT_FIELDS.has(field)) {
      const wasPoints = pointsOf(was);
      const nowPoints = pointsOf(now);
      const added = nowPoints.filter(point => !wasPoints.includes(point));
      const removed = wasPoints.filter(point => !nowPoints.includes(point));
      for (const point of added) lines.push(`${label}: added “${brief(point)}”`);
      for (const point of removed) lines.push(`${label}: removed “${brief(point)}”`);
      if (added.length === 0 && removed.length === 0) lines.push(`${label}: reordered`);
    } else if (now === null) lines.push(`${label}: removed`);
    else if (was === null) lines.push(`${label}: added`);
    else if (SHOWN_AS_TEXT.has(field)) lines.push(`${label}: now “${brief(now)}”`);
    else lines.push(`${label}: reworded`);
  }
  return lines.length > MOST_LINES
    ? [...lines.slice(0, MOST_LINES), `and ${String(lines.length - MOST_LINES)} more changes`]
    : lines;
};

const versions = (item: AgendaItem): readonly HistoryEvent[] =>
  (item.revisions ?? []).map(
    (revision, index) =>
      ({
        kind: 'revision',
        key: `revision:${revision.at}:${String(index)}`,
        at: Date.parse(revision.at) || 0,
        version: index + 2,
        summary: summarize(item, index),
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
