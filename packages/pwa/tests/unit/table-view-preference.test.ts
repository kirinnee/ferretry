import { describe, test } from 'bun:test';
import should from 'should';
import {
  DEFAULT_TABLE_VIEW,
  parseTableView,
  TABLE_VIEW_KEY,
  TableViewPreferenceStore,
  type TableViewStorage,
} from '../../src/lib/table-view-preference.ts';

const memory = (seed: Record<string, string> = {}): TableViewStorage & { readonly values: Map<string, string> } => {
  const values = new Map(Object.entries(seed));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

describe('parseTableView', () => {
  test('reads the two known words and resets anything else to cards', () => {
    should(parseTableView('table')).equal('table');
    should(parseTableView('cards')).equal('cards');
    should(parseTableView('TABLE')).equal('cards');
    should(parseTableView(null)).equal('cards');
    should(parseTableView(undefined)).equal('cards');
    should(DEFAULT_TABLE_VIEW).equal('cards');
  });
});

describe('TableViewPreferenceStore', () => {
  test('hydrates from this device, remembers a change and tells every table', () => {
    const storage = memory({ [TABLE_VIEW_KEY]: 'table' });
    const store = new TableViewPreferenceStore(storage);
    should(store.snapshot()).equal('table');
    let heard = 0;
    const unsubscribe = store.subscribe(() => {
      heard += 1;
    });
    store.set('cards');
    should(store.snapshot()).equal('cards');
    should(storage.values.get(TABLE_VIEW_KEY)).equal('cards');
    should(heard).equal(1);
    // Choosing the view already in force is not a change.
    store.set('cards');
    should(heard).equal(1);
    unsubscribe();
    store.set('table');
    should(heard).equal(1);
  });

  test('a denied storage still switches the view for the rest of the tab', () => {
    const denied: TableViewStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const store = new TableViewPreferenceStore(denied);
    should(store.snapshot()).equal('cards');
    store.set('table');
    should(store.snapshot()).equal('table');
    const none = new TableViewPreferenceStore(undefined);
    none.set('table');
    should(none.snapshot()).equal('table');
  });

  test('a browser whose storage getter throws or lacks the methods is read as having no storage', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const restore = (): void => {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    };
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => {
          throw new Error('storage access refused');
        },
      });
      const refused = new TableViewPreferenceStore();
      should(refused.snapshot()).equal('cards');
      refused.set('table');
      should(refused.snapshot()).equal('table');

      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {} });
      const incomplete = new TableViewPreferenceStore();
      incomplete.set('table');
      should(incomplete.snapshot()).equal('table');
      should(Object.keys(globalThis.localStorage)).deepEqual([]);
    } finally {
      restore();
    }
  });

  test('the browser default reads the real storage when there is one', () => {
    globalThis.localStorage?.removeItem?.(TABLE_VIEW_KEY);
    should(new TableViewPreferenceStore().snapshot()).equal('cards');
  });
});
