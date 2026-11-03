import { describe, test } from 'bun:test';
import should from 'should';
import {
  BOARD_PRIVATE_KEY,
  BoardPrivateStore,
  type BoardPrivateStorage,
  parseShowPrivate,
} from '../../src/lib/board-private-preference.ts';

const memory = (seed: Record<string, string> = {}): BoardPrivateStorage & { readonly values: Map<string, string> } => {
  const values = new Map(Object.entries(seed));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

describe('parseShowPrivate', () => {
  test('reads only 1 as on and resets anything else to off', () => {
    should(parseShowPrivate('1')).be.true();
    should(parseShowPrivate('0')).be.false();
    should(parseShowPrivate('true')).be.false();
    should(parseShowPrivate(null)).be.false();
    should(parseShowPrivate(undefined)).be.false();
  });
});

describe('BoardPrivateStore', () => {
  test('starts off, remembers a change on this device and tells every listener', () => {
    const storage = memory();
    const store = new BoardPrivateStore(storage);
    should(store.snapshot()).be.false();
    let heard = 0;
    const unsubscribe = store.subscribe(() => {
      heard += 1;
    });
    store.set(true);
    should(store.snapshot()).be.true();
    should(storage.values.get(BOARD_PRIVATE_KEY)).equal('1');
    should(heard).equal(1);
    store.set(true);
    should(heard).equal(1);
    unsubscribe();
    store.set(false);
    should(storage.values.get(BOARD_PRIVATE_KEY)).equal('0');
    should(heard).equal(1);
  });

  test('hydrates from storage', () => {
    should(new BoardPrivateStore(memory({ [BOARD_PRIVATE_KEY]: '1' })).snapshot()).be.true();
  });

  test('a denied storage still switches the choice for the rest of the tab', () => {
    const denied: BoardPrivateStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const store = new BoardPrivateStore(denied);
    should(store.snapshot()).be.false();
    store.set(true);
    should(store.snapshot()).be.true();
  });

  test('works with no storage at all', () => {
    const store = new BoardPrivateStore(undefined);
    store.set(true);
    should(store.snapshot()).be.true();
  });
});
