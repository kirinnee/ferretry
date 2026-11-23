/**
 * The PURE half of "Continue a past conversation": how a row reads, which rows a search and a date keep, and the listing
 * query the daemon searches with.
 *
 * Nothing here reads a clock: every rule that depends on "now" is handed it.
 */

import { TERMINAL_STATUSES } from '@ferretry/app';
import type { Instant } from '@ferretry/std';
import type { LinkableConversation, LinkQuery } from '../../contract/index.ts';
import type { HarnessKey } from './link-words.ts';

const DAY_MS = 86_400_000;

export type DateFilter = 'any' | '7d' | '30d';

export const DATE_FILTERS: readonly { readonly id: DateFilter; readonly label: string; readonly title: string }[] = [
  { id: 'any', label: 'Any', title: 'Any time' },
  { id: '7d', label: '7d', title: 'Last 7 days' },
  { id: '30d', label: '30d', title: 'Last 30 days' },
];

const FILTER_DAYS: Readonly<Record<Exclude<DateFilter, 'any'>, number>> = { '7d': 7, '30d': 30 };

/** The earliest instant a date filter keeps, or none for "Any time". */
export const sinceInstant = (filter: DateFilter, now: number): string | undefined =>
  filter === 'any' ? undefined : new Date(now - FILTER_DAYS[filter] * DAY_MS).toISOString();

const words = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/\s+/u)
    .filter(word => word !== '');

/**
 * Every typed word appears in the name, the first message, the latest one, the folder, or the `also`
 * text a caller adds (the name of the ferret keeping it). Case does not matter.
 */
export const matchesSearch = (row: LinkableConversation, text: string, also = ''): boolean => {
  const haystack = `${row.name ?? ''}\n${row.preview}\n${row.latest ?? ''}\n${row.project}\n${also}`.toLowerCase();
  return words(text).every(word => haystack.includes(word));
};

/** The words a row's lines are made of: the title leads, and nothing labels it with the opening message. */
export interface ConversationHeadline {
  readonly headline: string;
  /** Whether the headline is a title, as opposed to the first message standing in for one. */
  readonly named: boolean;
}

/**
 * A conversation's headline is what it is ABOUT: its title (the owner's, the CLI's, else one made from the first exchange;
 * the daemon names every row it can), and only a conversation with no name at all is headed by its first message, cleaned.
 * The ferret that keeps it is a mark of its own, so a ferret's callsign never stands in for the subject and the first message
 * is never printed under a title.
 */
export const conversationHeadline = (row: LinkableConversation): ConversationHeadline => {
  const first = row.preview.trim() === '' ? undefined : row.preview;
  if (row.name === undefined) return { headline: first ?? 'No message preview', named: false };
  return { headline: row.name, named: true };
};

/** The ferret that keeps a conversation: its name, and how it is when the app has read it. */
export interface FerretMark {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
}

/** A ferret's state as its avatar dot says it: live, stopped, or failed; nothing when it was not read. */
export const ferretState = (status: string | undefined): 'live' | 'stopped' | 'failed' | undefined => {
  if (status === undefined) return undefined;
  if (status === 'failed') return 'failed';
  return (TERMINAL_STATUSES as ReadonlySet<string>).has(status) ? 'stopped' : 'live';
};

export const matchesDate = (row: LinkableConversation, filter: DateFilter, now: number): boolean => {
  const since = sinceInstant(filter, now);
  return since === undefined || Date.parse(row.lastActivityAt) >= Date.parse(since);
};

export type HarnessFilter = 'all' | HarnessKey;

/** The daemon-side search the Continue list sends: only the narrowing it has. */
export const listingQuery = (
  search: { readonly text: string; readonly harness: HarnessFilter; readonly date: DateFilter },
  now: number,
  limit?: number,
): LinkQuery => {
  const text = search.text.trim();
  const since = sinceInstant(search.date, now);
  return {
    ...(search.harness === 'all' ? {} : { harness: search.harness }),
    ...(text === '' ? {} : { q: text }),
    ...(since === undefined ? {} : { since: since as Instant }),
    ...(limit === undefined ? {} : { limit }),
  };
};

/** The listing's query string: only what narrows it. */
export const listingQueryParams = (query: LinkQuery): Record<string, string> => ({
  ...(query.source === undefined ? {} : { source: query.source }),
  ...(query.harness === undefined ? {} : { harness: query.harness }),
  ...(query.q === undefined ? {} : { q: query.q }),
  ...(query.since === undefined ? {} : { since: query.since }),
  ...(query.limit === undefined ? {} : { limit: String(query.limit) }),
});
