import { describe, expect, test } from 'bun:test';
import type { LogSearch } from '../../../../contract/index.ts';
import {
  type ChatSearchState,
  currentMatch,
  EMPTY_CHAT_SEARCH,
  matchLabel,
  occurrences,
  rowAnchors,
  rowForOffset,
  stepMatch,
  withResults,
} from '../../../../app/search/chat-search-model.ts';

const match = (offset: number) => ({ offset, role: 'user', kind: 'message', snippet: `at ${String(offset)}` });
const answer = (offsets: readonly number[], truncated = false): LogSearch => ({
  v: 1,
  ferret: 'f1' as LogSearch['ferret'],
  query: 'q',
  file: 'f1',
  matches: offsets.map(match),
  truncated,
});
const searched = (offsets: readonly number[], truncated = false): ChatSearchState =>
  withResults({ ...EMPTY_CHAT_SEARCH, query: 'q', status: 'searching' }, answer(offsets, truncated));

describe('the chat search model', () => {
  test('starts at the newest match', () => {
    const state = searched([10, 20, 30]);
    expect(state.current).toBe(2);
    expect(state.file).toBe('f1');
    expect(currentMatch(state)?.offset).toBe(30);
    expect(matchLabel(state)).toBe('3 of 3');
  });

  test('walks back and forward, wrapping at either end', () => {
    const state = searched([10, 20, 30]);
    expect(stepMatch(state, 'older').current).toBe(1);
    expect(stepMatch(stepMatch(stepMatch(state, 'older'), 'older'), 'older').current).toBe(2);
    expect(stepMatch(state, 'newer').current).toBe(0);
  });

  test('has nothing to step through when there is no match', () => {
    const state = searched([]);
    expect(state.current).toBeNull();
    expect(stepMatch(state, 'older')).toBe(state);
    expect(currentMatch(state)).toBeUndefined();
    expect(matchLabel(state)).toBe('No matches');
  });

  test('says what it is doing, and marks a count it stopped short of', () => {
    expect(matchLabel(EMPTY_CHAT_SEARCH)).toBe('');
    expect(matchLabel({ ...EMPTY_CHAT_SEARCH, query: 'q', status: 'searching' })).toBe('Searching…');
    expect(matchLabel({ ...EMPTY_CHAT_SEARCH, query: 'q', status: 'error' })).toBe('Search failed');
    expect(matchLabel(searched([1, 2], true))).toBe('2 of 2+');
  });

  test('finds the row a match is in: the last that begins at or before it', () => {
    const rows = [
      { offset: 0, row: 'a' },
      { offset: 100, row: 'b' },
      { offset: 300, row: 'c' },
    ];
    expect(rowForOffset(rows, 150)).toBe('b');
    expect(rowForOffset(rows, 300)).toBe('c');
    expect(rowForOffset(rows, 999)).toBe('c');
    expect(rowForOffset([{ offset: 50, row: 'z' }], 10)).toBeUndefined();
  });

  test('finds the row a record belongs to though rows interleave, by every byte each stands for', () => {
    const rows = rowAnchors([
      { offset: 100, also: [300], row: 'alpha' },
      { offset: 400, also: [200], row: 'beta' },
      { offset: 500, row: 'gamma' },
    ]);
    expect(rows.map(row => [row.offset, row.row])).toEqual([
      [100, 'alpha'],
      [200, 'beta'],
      [300, 'alpha'],
      [400, 'beta'],
      [500, 'gamma'],
    ]);
    expect([100, 200, 300, 400, 550].map(offset => rowForOffset(rows, offset))).toEqual([
      'alpha',
      'beta',
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  test('finds every occurrence, in any case', () => {
    expect(occurrences('The parser, the PARSER.', 'parser')).toEqual([
      [4, 10],
      [16, 22],
    ]);
    expect(occurrences('anything', '')).toEqual([]);
    // A text whose lower-casing changes its length cannot be mapped back, so it is left unpainted.
    expect(occurrences('İstanbul parser', 'parser')).toEqual([]);
  });
});
