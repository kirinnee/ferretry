import { describe, expect, it } from 'bun:test';

import {
  addSavedQuery,
  browserSavedQueriesStorage,
  loadSavedQueries,
  MAX_SAVED_QUERIES,
  parseSavedQueries,
  persistSavedQueries,
  removeSavedQuery,
  SAVED_QUERIES_KEY,
  type SavedQueriesStorage,
} from '../../../src/features/analytics/analytics-saved-queries.ts';

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const memory = (): SavedQueriesStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
};
const throwing: SavedQueriesStorage = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
};

describe('saved analytics queries', () => {
  it('parses defensively', () => {
    expect(parseSavedQueries(null)).toEqual([]);
    expect(parseSavedQueries('{nope')).toEqual([]);
    expect(parseSavedQueries('{"a":1}')).toEqual([]);
    expect(
      parseSavedQueries(
        JSON.stringify([null, 3, { id: 'a', name: 'n', query: 'q' }, { id: '', name: 'n', query: 'q' }]),
      ),
    ).toEqual([{ id: 'a', name: 'n', query: 'q' }]);
    const many = Array.from({ length: MAX_SAVED_QUERIES + 5 }, (_, i) => ({ id: `${i}`, name: `n${i}`, query: 'q' }));
    expect(parseSavedQueries(JSON.stringify(many))).toHaveLength(MAX_SAVED_QUERIES);
  });

  it('adds, replaces by name, ignores blanks, caps and removes', () => {
    const make = ids();
    let list = addSavedQuery([], '  Cost  ', ' sum(cost_usd) ', make);
    expect(list).toEqual([{ id: 'id-1', name: 'Cost', query: 'sum(cost_usd)' }]);
    expect(addSavedQuery(list, ' ', 'q', make)).toBe(list);
    expect(addSavedQuery(list, 'x', ' ', make)).toBe(list);
    list = addSavedQuery(list, 'cost', 'sum(tokens)', make);
    expect(list).toEqual([{ id: 'id-1', name: 'cost', query: 'sum(tokens)' }]);
    list = addSavedQuery(list, 'Other', 'avg(turns)', make);
    expect(list).toHaveLength(2);
    expect(removeSavedQuery(list, 'id-1')).toEqual([{ id: 'id-2', name: 'Other', query: 'avg(turns)' }]);
    let full = list;
    for (let i = 0; i < MAX_SAVED_QUERIES + 3; i += 1) full = addSavedQuery(full, `n${i}`, 'q', make);
    expect(full).toHaveLength(MAX_SAVED_QUERIES);
    expect(addSavedQuery([], 'a'.repeat(200), 'q', make)[0]!.name).toHaveLength(80);
  });

  it('round-trips through storage and survives a denied one', () => {
    const storage = memory();
    const list = [{ id: 'a', name: 'n', query: 'q' }];
    expect(persistSavedQueries(storage, list)).toBe(true);
    expect(storage.data.get(SAVED_QUERIES_KEY)).toBeDefined();
    expect(loadSavedQueries(storage)).toEqual(list);
    expect(persistSavedQueries(throwing, list)).toBe(false);
    expect(persistSavedQueries(undefined, list)).toBe(false);
    expect(loadSavedQueries(throwing)).toEqual([]);
    expect(loadSavedQueries(undefined)).toEqual([]);
  });

  it('finds the browser storage only when it is usable', () => {
    const holder = globalThis as { localStorage?: unknown };
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memory() });
      expect(browserSavedQueriesStorage()).toBeDefined();
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {} });
      expect(browserSavedQueriesStorage()).toBeUndefined();
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('blocked');
        },
      });
      expect(browserSavedQueriesStorage()).toBeUndefined();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete holder.localStorage;
    }
  });
});
