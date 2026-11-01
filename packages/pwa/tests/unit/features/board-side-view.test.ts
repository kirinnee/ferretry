import { describe, test } from 'bun:test';
import should from 'should';
import {
  BOARD_SIDE_VIEW_KEY,
  BoardSideViewStore,
  type BoardSideViewStorage,
  DEFAULT_BOARD_SIDE_VIEW,
  parseBoardSideView,
} from '../../../src/lib/board-side-view.ts';

const memory = (seed: Record<string, string> = {}): BoardSideViewStorage & { readonly values: Map<string, string> } => {
  const values = new Map(Object.entries(seed));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

describe('parseBoardSideView', () => {
  test('reads the three views and resets anything else to the Cards', () => {
    should(parseBoardSideView('list')).equal('list');
    should(parseBoardSideView('kanban')).equal('kanban');
    should(parseBoardSideView('cards')).equal('cards');
    should(parseBoardSideView('LIST')).equal('cards');
    should(parseBoardSideView(null)).equal('cards');
    should(parseBoardSideView(undefined)).equal('cards');
    should(DEFAULT_BOARD_SIDE_VIEW).equal('cards');
  });
});

describe('BoardSideViewStore', () => {
  test('hydrates from this device, remembers a change and tells every Tasks tab', () => {
    const storage = memory({ [BOARD_SIDE_VIEW_KEY]: 'list' });
    const store = new BoardSideViewStore(storage);
    should(store.snapshot()).equal('list');
    let heard = 0;
    const unsubscribe = store.subscribe(() => {
      heard += 1;
    });
    store.set('kanban');
    should(store.snapshot()).equal('kanban');
    should(storage.values.get(BOARD_SIDE_VIEW_KEY)).equal('kanban');
    should(heard).equal(1);
    store.set('kanban');
    should(heard).equal(1);
    unsubscribe();
    store.set('list');
    should(heard).equal(1);
  });

  test('a denied storage still switches the view for the rest of the tab', () => {
    const denied: BoardSideViewStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const store = new BoardSideViewStore(denied);
    should(store.snapshot()).equal('cards');
    store.set('list');
    should(store.snapshot()).equal('list');
  });

  test('a fresh device, with nothing stored, starts on the Cards and remembers a pick', () => {
    const storage = memory();
    const store = new BoardSideViewStore(storage);
    should(store.snapshot()).equal('cards');
    store.set('kanban');
    should(storage.values.get(BOARD_SIDE_VIEW_KEY)).equal('kanban');
    should(new BoardSideViewStore(storage).snapshot()).equal('kanban');
  });

  test('with no storage at all it starts on the Cards', () => {
    const store = new BoardSideViewStore(undefined);
    should(store.snapshot()).equal('cards');
    store.set('list');
    should(store.snapshot()).equal('list');
  });
});

describe('the device storage the store defaults to', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const restore = (): void => {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', original);
  };
  const stub = (descriptor: PropertyDescriptor): void => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...descriptor });
  };

  test('uses localStorage when the browser offers one', () => {
    const storage = memory({ [BOARD_SIDE_VIEW_KEY]: 'list' });
    stub({ value: storage });
    try {
      const store = new BoardSideViewStore();
      should(store.snapshot()).equal('list');
      store.set('kanban');
      should(storage.values.get(BOARD_SIDE_VIEW_KEY)).equal('kanban');
    } finally {
      restore();
    }
  });

  test('falls back to memory when there is none, or it is not a storage', () => {
    for (const value of [undefined, {}]) {
      stub({ value });
      try {
        const store = new BoardSideViewStore();
        should(store.snapshot()).equal('cards');
        store.set('list');
        should(store.snapshot()).equal('list');
      } finally {
        restore();
      }
    }
  });

  test('falls back to memory when merely reading localStorage is refused', () => {
    stub({
      get: () => {
        throw new Error('blocked');
      },
    });
    try {
      const store = new BoardSideViewStore();
      should(store.snapshot()).equal('cards');
      store.set('list');
      should(store.snapshot()).equal('list');
    } finally {
      restore();
    }
  });
});
