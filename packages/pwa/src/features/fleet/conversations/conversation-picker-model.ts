/**
 * The PURE half of keeping existing Claude Code / Codex conversations as ferrets: which rows the picker
 * shows, how they group, what may be ticked, the adoption it sends, the listing query the daemon
 * searches with, and which runtime a picked conversation runs on.
 *
 * Nothing here reads a clock: every rule that depends on "now" is handed it.
 */

import {
  CONVERSATION_IMPORT_PATH,
  CONVERSATION_LAUNCH_MAX,
  type ConversationAdoptRequest,
  type ConversationImportQuery,
  type FleetRuntimeView,
  type Harness,
  type ImportableConversation,
} from '@ferretry/protocol';
import { SETUP_HARNESS_NAMES } from '../setup/setup-words.ts';

const DAY_MS = 86_400_000;

/** How many rows the picker shows before "Show all". */
export const RECENT_LIMIT = 20;

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

/** Every typed word appears in the first message, the latest one, or the folder. Case does not matter. */
export const matchesSearch = (row: ImportableConversation, text: string): boolean => {
  const haystack = `${row.preview}\n${row.latest ?? ''}\n${row.project}`.toLowerCase();
  return words(text).every(word => haystack.includes(word));
};

export const matchesDate = (row: ImportableConversation, filter: DateFilter, now: number): boolean => {
  const since = sinceInstant(filter, now);
  return since === undefined || Date.parse(row.lastActivityAt) >= Date.parse(since);
};

const newestFirst = (rows: readonly ImportableConversation[]): readonly ImportableConversation[] =>
  [...rows].sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

export interface PickerFilter {
  readonly text: string;
  readonly date: DateFilter;
  readonly showAll: boolean;
}

export const EMPTY_FILTER: PickerFilter = { text: '', date: 'any', showAll: false };

export interface VisibleConversations {
  readonly rows: readonly ImportableConversation[];
  /** How many matched but are held back until "Show all". */
  readonly hidden: number;
}

/** The rows on screen: matching, newest first, the 20 most recent unless "Show all". */
export const visibleConversations = (
  rows: readonly ImportableConversation[],
  filter: PickerFilter,
  now: number,
): VisibleConversations => {
  const matching = newestFirst(rows).filter(
    row => matchesSearch(row, filter.text) && matchesDate(row, filter.date, now),
  );
  const shown = filter.showAll ? matching : matching.slice(0, RECENT_LIMIT);
  return { rows: shown, hidden: matching.length - shown.length };
};

/** The last two segments of a folder, which is as much of the path as a row has room to say. */
export const folderLabel = (project: string): string => {
  const segments = project.split(/[\\/]+/u).filter(segment => segment !== '');
  return segments.length === 0 ? project : segments.slice(-2).join('/');
};

/** "Found 12 conversations · 2 already kept". */
export const foundLine = (rows: readonly ImportableConversation[]): string => {
  const kept = rows.filter(row => row.adoptedBy !== undefined).length;
  const found = `Found ${rows.length} ${rows.length === 1 ? 'conversation' : 'conversations'}`;
  return kept === 0 ? found : `${found} · ${kept} already kept`;
};

export interface PickerSelection {
  /** Conversation ids to keep as ferrets. */
  readonly keep: readonly string[];
  /** The kept ids to launch now; never more than `CONVERSATION_LAUNCH_MAX`. */
  readonly start: readonly string[];
}

export const EMPTY_SELECTION: PickerSelection = { keep: [], start: [] };

export const START_LIMIT_HINT = `Up to ${CONVERSATION_LAUNCH_MAX} start at once; the rest stay stopped, ready to resume.`;

/** Tick or untick "Keep as a ferret". A row a ferret already keeps cannot be picked; unticking also stops "Start now". */
export const toggleKeep = (selection: PickerSelection, row: ImportableConversation, on: boolean): PickerSelection => {
  if (row.adoptedBy !== undefined) return selection;
  if (on) return selection.keep.includes(row.id) ? selection : { ...selection, keep: [...selection.keep, row.id] };
  return { keep: selection.keep.filter(id => id !== row.id), start: selection.start.filter(id => id !== row.id) };
};

export type StartToggle =
  | { readonly kind: 'ok'; readonly selection: PickerSelection }
  | { readonly kind: 'refused'; readonly sentence: string };

/** "Start now" on a kept row, refused for a row not kept and for one past the launch limit. */
export const toggleStart = (selection: PickerSelection, id: string, on: boolean): StartToggle => {
  if (!on) return { kind: 'ok', selection: { ...selection, start: selection.start.filter(item => item !== id) } };
  if (!selection.keep.includes(id)) return { kind: 'refused', sentence: 'Keep this conversation first.' };
  if (selection.start.includes(id)) return { kind: 'ok', selection };
  if (selection.start.length >= CONVERSATION_LAUNCH_MAX) return { kind: 'refused', sentence: START_LIMIT_HINT };
  return { kind: 'ok', selection: { ...selection, start: [...selection.start, id] } };
};

/** "Select last 7 days": keeps every row active in the window that no ferret keeps yet. */
export const selectLastDays = (
  rows: readonly ImportableConversation[],
  selection: PickerSelection,
  now: number,
  days: number,
): PickerSelection => {
  const since = now - days * DAY_MS;
  const fresh = rows.filter(
    row => row.adoptedBy === undefined && Date.parse(row.lastActivityAt) >= since && !selection.keep.includes(row.id),
  );
  return { ...selection, keep: [...selection.keep, ...fresh.map(row => row.id)] };
};

/** The one adoption the footer sends: every kept row, launched only when "Start now" is on. */
export const adoptRequest = (
  harness: Harness,
  runtime: string,
  selection: PickerSelection,
): ConversationAdoptRequest => ({
  harness,
  runtime,
  conversations: selection.keep.map(id => ({ id, start: selection.start.includes(id) })),
});

/** "Keep 3 as ferrets". */
export const keepButtonLabel = (count: number): string =>
  count === 1 ? 'Keep 1 as a ferret' : `Keep ${count} as ferrets`;

export type RuntimeChoice =
  | { readonly kind: 'none'; readonly sentence: string }
  | { readonly kind: 'one'; readonly runtime: FleetRuntimeView }
  | { readonly kind: 'several'; readonly runtimes: readonly FleetRuntimeView[] };

/** Which runtime a conversation of this CLI runs on: the only one, a choice, or a sentence saying there is none. */
export const runtimeChoice = (runtimes: readonly FleetRuntimeView[], harness: Harness): RuntimeChoice => {
  const fitting = runtimes.filter(runtime => runtime.harness === harness);
  const [only] = fitting;
  if (only === undefined)
    return {
      kind: 'none',
      sentence: `No ${SETUP_HARNESS_NAMES[harness]} runtime on this machine yet. Add one in Settings › Runtimes, then try again.`,
    };
  return fitting.length === 1 ? { kind: 'one', runtime: only } : { kind: 'several', runtimes: fitting };
};

export type HarnessFilter = 'all' | Harness;

export const HARNESS_FILTERS: readonly { readonly id: HarnessFilter; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

/** The daemon-side search the Continue mode sends: only the narrowing it has. */
export const listingQuery = (
  search: { readonly text: string; readonly harness: HarnessFilter; readonly date: DateFilter },
  now: number,
  limit?: number,
): ConversationImportQuery => {
  const text = search.text.trim();
  const since = sinceInstant(search.date, now);
  return {
    ...(search.harness === 'all' ? {} : { harness: search.harness }),
    ...(text === '' ? {} : { q: text }),
    ...(since === undefined ? {} : { since }),
    ...(limit === undefined ? {} : { limit }),
  };
};

/** The listing's address: the path, and a query string only when something narrows it. */
export const listingPath = (query: ConversationImportQuery): string => {
  const params = new URLSearchParams();
  if (query.source !== undefined) params.set('source', query.source);
  if (query.harness !== undefined) params.set('harness', query.harness);
  if (query.q !== undefined) params.set('q', query.q);
  if (query.since !== undefined) params.set('since', query.since);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const search = params.toString();
  return search === '' ? CONVERSATION_IMPORT_PATH : `${CONVERSATION_IMPORT_PATH}?${search}`;
};
