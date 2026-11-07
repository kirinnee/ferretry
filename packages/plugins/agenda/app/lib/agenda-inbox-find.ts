/**
 * INBOX FIND, as pure decisions: with words typed, Find looks in EVERY tab at once and each row says which tab
 * it came from.
 *
 * WHY. Find used to search only the tab you were on, so "credential" typed on Open never showed the snoozed
 * or replied duplicate you were hunting for. Words typed now search the open items, the ones with ferrets,
 * the snoozed and replied ones, the resolved ones and the cards to test (snoozed ones too). An EMPTY Find is
 * not a search: every tab keeps its own list, exactly as before.
 *
 * Each row carries a STATE CHIP — "Open", "With zoe", "Snoozed · 09:00", "Replied", "Resolved", or the
 * lane a card is in — so a row is never mistaken for work that is waiting on you now.
 */

import type { Opaque } from '../shell.ts';
import type { AgendaItem } from '../wire/index.ts';
import type { InboxCard, InboxResolved } from './agenda-inbox.ts';
import {
  filterInboxCards,
  filterInboxResolved,
  type InboxListFilter,
  inboxWho,
  parkedBy,
} from './agenda-inbox-list.ts';
import { clockWords, parkedUntilWords } from './agenda-status.ts';
import { filterToTest, type ToTestCard } from './to-test-inbox.ts';

/** What the chip is about; the page tints it from this and never parses the words. */
export type FindTone = 'open' | 'with-ferret' | 'snoozed' | 'replied' | 'resolved' | 'card';

interface FindChip {
  readonly tone: FindTone;
  /** Short enough to stay on one line on a phone. */
  readonly label: string;
  /** The full wording, for the chip's tooltip and accessible name; the label itself when it is already whole. */
  readonly full: string;
}

export type FindRow =
  | { readonly kind: 'agenda'; readonly key: string; readonly card: InboxCard; readonly chip: FindChip }
  | { readonly kind: 'resolved'; readonly key: string; readonly row: InboxResolved; readonly chip: FindChip }
  | { readonly kind: 'card'; readonly key: string; readonly row: ToTestCard; readonly chip: FindChip };

/** The inbox lists Find reads: all of them. */
export interface FindSources {
  readonly cards: readonly InboxCard[];
  readonly withFerret: readonly InboxCard[];
  readonly parked: readonly InboxCard[];
  readonly resolved: readonly InboxResolved[];
  readonly toTest: readonly ToTestCard[];
  readonly toTestSnoozed: readonly ToTestCard[];
}

/** Find is a search only once words are typed. */
export const isFinding = (query: string): boolean => query.trim() !== '';

const SNOOZED = 'Snoozed';

/** The lane a card to test sits in, in the project's own words; "To test" when the lanes are not known. */
const cardLaneLabel = (row: ToTestCard): string =>
  row.group.laneSet?.lanes.find((lane: Opaque) => lane.id === row.card.task.laneId)?.name ?? 'To test';

const plainChip = (tone: FindTone, label: string): FindChip => ({ tone, label, full: label });

/** "Snoozed · tmrw 09:00" on the chip, "Snoozed until tomorrow 09:00" in its tooltip; plain "Snoozed" when the wake is unknown. */
const snoozedChip = (words: string | null): FindChip =>
  words === null
    ? plainChip('snoozed', SNOOZED)
    : {
        tone: 'snoozed',
        label: `${SNOOZED} · ${words.replace(/^tomorrow /u, 'tmrw ')}`,
        full: `${SNOOZED} until ${words}`,
      };

const snoozedUntil = (until: string | null, now: number): FindChip =>
  snoozedChip(until === null ? null : clockWords(until, now));

const parkedChip = (item: Pick<AgendaItem, 'parked' | 'neededBy'>, now: number): FindChip =>
  item.parked?.reason === 'replied' ? plainChip('replied', 'Replied') : snoozedChip(parkedUntilWords(item, now));

/**
 * Every row the words match, tab by tab in the order the Show menu lists them — Open (with the items on a
 * ferret), cards to test, Snoozed, Replied, Resolved. The machine, ferret-kind and Warden filters still apply.
 */
export const findRows = (
  sources: FindSources,
  filter: InboxListFilter,
  agendaOnly: boolean,
  now: number,
): readonly FindRow[] => {
  const agenda = (card: InboxCard, chip: FindChip): FindRow => ({ kind: 'agenda', key: card.key, card, chip });
  const toTest = (row: ToTestCard, chip: FindChip): FindRow => ({ kind: 'card', key: row.key, row, chip });
  const toTestFilter = { machine: filter.machine, query: filter.query, agendaOnly };
  return [
    ...filterInboxCards(sources.cards, filter).map(card => agenda(card, plainChip('open', 'Open'))),
    ...filterInboxCards(sources.withFerret, filter).map(card =>
      agenda(card, plainChip('with-ferret', `With ${inboxWho(card).ferret}`)),
    ),
    ...filterToTest(sources.toTest, toTestFilter).map(row => toTest(row, plainChip('card', cardLaneLabel(row)))),
    ...filterInboxCards(parkedBy(sources.parked, 'snoozed'), filter).map(card =>
      agenda(card, parkedChip(card.item, now)),
    ),
    ...filterToTest(sources.toTestSnoozed, toTestFilter).map(row => toTest(row, snoozedUntil(row.snoozedUntil, now))),
    ...filterInboxCards(parkedBy(sources.parked, 'replied'), filter).map(card =>
      agenda(card, parkedChip(card.item, now)),
    ),
    ...filterInboxResolved(sources.resolved, filter).map(
      (row): FindRow => ({
        kind: 'resolved',
        key: `${row.key}:${row.record.resolvedAt}`,
        row,
        chip: plainChip('resolved', 'Resolved'),
      }),
    ),
  ];
};
