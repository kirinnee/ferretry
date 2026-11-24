import { describe, expect, test } from 'bun:test';
import { agoWords, LIVE_MODEL_LIST_FRESH_MS, liveModelPicker } from '../../../src/ui/live-model-list.ts';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const CURATED = [{ id: 'kimi-k3' }, { id: 'kimi-k3-turbo' }, { id: 'claude-opus-5-5[1m]' }];

interface Row {
  readonly name: string;
  readonly ids: readonly string[];
  readonly complete?: boolean;
  readonly notOffered: readonly string[];
  readonly newIds: readonly string[];
}

const ROWS: readonly Row[] = [
  {
    name: 'every curated model listed: nothing missing, nothing new',
    ids: ['kimi-k3', 'kimi-k3-turbo', 'claude-opus-5-5'],
    notOffered: [],
    newIds: [],
  },
  {
    name: 'a curated model the list lacks is marked, and stays in the list',
    ids: ['kimi-k3'],
    notOffered: ['kimi-k3-turbo', 'claude-opus-5-5[1m]'],
    newIds: [],
  },
  {
    name: 'an id only the list has is new, in id order, once',
    ids: ['kimi-k3', 'zeta-1', 'kimi-k3-turbo', 'alpha-2', 'zeta-1', 'claude-opus-5-5'],
    notOffered: [],
    newIds: ['alpha-2', 'zeta-1'],
  },
  {
    name: 'a paged or cut list proves nothing about a missing id, but its extra ids are still offered',
    ids: ['kimi-k3', 'alpha-2'],
    complete: false,
    notOffered: [],
    newIds: ['alpha-2'],
  },
  {
    name: 'a dated snapshot of a curated model is that model, not a new one and not a missing one',
    ids: ['kimi-k3', 'kimi-k3-turbo', 'claude-opus-5-5-20261101'],
    notOffered: [],
    newIds: [],
  },
  {
    name: 'an empty complete list marks every curated model',
    ids: [],
    notOffered: ['kimi-k3', 'kimi-k3-turbo', 'claude-opus-5-5[1m]'],
    newIds: [],
  },
];

describe('liveModelPicker', () => {
  for (const row of ROWS)
    test(row.name, () => {
      const picker = liveModelPicker(
        CURATED,
        { fetchedAt: ago(HOUR), complete: row.complete ?? true, ids: row.ids },
        NOW,
      );
      expect([...picker.notOffered].sort()).toEqual([...row.notOffered].sort());
      expect(picker.newIds).toEqual(row.newIds);
    });

  test('a model installed from a local server is never judged against a provider list', () => {
    const picker = liveModelPicker(
      [{ id: 'gpt-oss:20b', local: true }, { id: 'kimi-k3' }],
      { fetchedAt: ago(HOUR), complete: true, ids: ['kimi-k3'] },
      NOW,
    );
    expect([...picker.notOffered]).toEqual([]);
  });

  test('a list is stale from a day old on, and not before', () => {
    const at = (age: number) => liveModelPicker(CURATED, { fetchedAt: ago(age), complete: true, ids: [] }, NOW).stale;
    expect(at(LIVE_MODEL_LIST_FRESH_MS - 1)).toBe(false);
    expect(at(LIVE_MODEL_LIST_FRESH_MS)).toBe(true);
    expect(at(9 * DAY)).toBe(true);
  });

  test('an unreadable time is never called stale', () => {
    expect(liveModelPicker(CURATED, { fetchedAt: 'not a time', complete: true, ids: [] }, NOW).stale).toBe(false);
  });
});

describe('agoWords', () => {
  const rows: readonly (readonly [number, string])[] = [
    [0, 'just now'],
    [HOUR - 1, 'just now'],
    [HOUR, '1 hour ago'],
    [5 * HOUR, '5 hours ago'],
    [DAY, '1 day ago'],
    [3 * DAY + 5 * HOUR, '3 days ago'],
    [-HOUR, 'just now'],
  ];
  for (const [age, words] of rows)
    test(`${String(age)} ms is "${words}"`, () => expect(agoWords(ago(age), NOW)).toBe(words));
});
