/**
 * SEARCH WITHIN A CONVERSATION — the pure half: what the bar says, which match is current, and where in
 * the chat a match's row is.
 *
 * The daemon searches the WHOLE transcript (`GET /v1/sessions/:id/log-search`), not just what the chat
 * has loaded, and answers every match oldest first with the byte its record begins at. The chat starts
 * at the newest match — the one nearest what the reader was looking at — and ↑ walks back in time, ↓
 * forward, wrapping at either end. Jumping to a match loads the history back to its byte, then scrolls
 * to the last row that begins at or before it: the row that holds it.
 */

import type { SessionLogSearch, SessionLogSearchMatch } from '@ferretry/protocol';

/** Whose words are searched: everyone's, the owner's own, or the agent's. */
export type ChatSearchWho = 'all' | 'me' | 'agent';

/** How long typing settles before a search is asked, so a word is one search rather than one a letter. */
export const CHAT_SEARCH_SETTLE_MS = 300;

export interface ChatSearchState {
  readonly query: string;
  readonly who: ChatSearchWho;
  /** Tool calls, their results and thinking are searched too. */
  readonly tools: boolean;
  readonly status: 'idle' | 'searching' | 'done' | 'error';
  /** The last answer's matches, oldest first. */
  readonly matches: readonly SessionLogSearchMatch[];
  /** The search stopped at its limit: there may be older matches it did not look for. */
  readonly truncated: boolean;
  /** The transcript file the matches came from, so a jump never looks for one in another file's pages. */
  readonly file: string | null;
  /** Which match is current, or `null` when there are none. */
  readonly current: number | null;
  /** Why the last search failed, in its own words. */
  readonly error: string | null;
}

export const EMPTY_CHAT_SEARCH: ChatSearchState = {
  query: '',
  who: 'all',
  tools: false,
  status: 'idle',
  matches: [],
  truncated: false,
  file: null,
  current: null,
  error: null,
};

/** A search's answer applied: the newest match is current. */
export const withResults = (state: ChatSearchState, answer: SessionLogSearch): ChatSearchState => ({
  ...state,
  status: 'done',
  matches: answer.matches,
  truncated: answer.truncated,
  file: answer.file,
  current: answer.matches.length === 0 ? null : answer.matches.length - 1,
  error: null,
});

/** The next match back in time (`older`) or forward, wrapping at either end. */
export const stepMatch = (state: ChatSearchState, direction: 'older' | 'newer'): ChatSearchState => {
  const count = state.matches.length;
  if (count === 0 || state.current === null) return state;
  const current = (state.current + (direction === 'older' ? count - 1 : 1)) % count;
  return { ...state, current };
};

/**
 * What the bar says about the matches: "3 of 27", "No matches", "Searching…". A search that stopped at
 * its limit says so with a "+", since older matches may exist that it did not count.
 */
export const matchLabel = (state: ChatSearchState): string => {
  if (state.query.trim() === '') return '';
  if (state.status === 'searching') return 'Searching…';
  if (state.status === 'error') return 'Search failed';
  if (state.current === null) return 'No matches';
  return `${String(state.current + 1)} of ${String(state.matches.length)}${state.truncated ? '+' : ''}`;
};

/** The current match, if any. */
export const currentMatch = (state: ChatSearchState): SessionLogSearchMatch | undefined =>
  state.current === null ? undefined : state.matches[state.current];

/**
 * Which row holds a match at `offset`: the last of `rows` (in transcript order, each with the byte its
 * first record begins at) that begins at or before it. `undefined` when every row begins after it — the
 * history has not been loaded back that far.
 */
export const rowForOffset = <Row>(
  rows: readonly { readonly offset: number; readonly row: Row }[],
  offset: number,
): Row | undefined => {
  let found: Row | undefined;
  for (const candidate of rows) {
    if (candidate.offset > offset) break;
    found = candidate.row;
  }
  return found;
};

/** Every place `query` occurs in `text`, case-insensitively, as `[start, end)` pairs. */
export const occurrences = (text: string, query: string): readonly (readonly [number, number])[] => {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  const haystack = text.toLowerCase();
  // Lower-casing can change a string's length; only a string it leaves the same length maps back.
  if (haystack.length !== text.length) return [];
  const found: (readonly [number, number])[] = [];
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    found.push([at, at + needle.length]);
    at = haystack.indexOf(needle, at + needle.length);
  }
  return found;
};
