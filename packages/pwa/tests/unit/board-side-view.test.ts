import { describe, test } from 'bun:test';
import should from 'should';
import {
  BOARD_SIDE_VIEW_KEY,
  BoardSideViewStore,
  type BoardSideViewStorage,
  DEFAULT_BOARD_SIDE_VIEW,
  parseBoardSideView,
} from '../../src/lib/board-side-view.ts';

const memory = (seed: Record<string, string> = {}): BoardSideViewStorage & { readonly values: Map<string, string> } => {
  const values = new Map(Object.entries(seed));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

describe('parseBoardSideView', () => {
  test('reads list and resets anything else to the Kanban', () => {
    should(parseBoardSideView('list')).equal('list');
    should(parseBoardSideView('kanban')).equal('kanban');
    should(parseBoardSideView('LIST')).equal('kanban');
    should(parseBoardSideView(null)).equal('kanban');
    should(parseBoardSideView(undefined)).equal('kanban');
    should(DEFAULT_BOARD_SIDE_VIEW).equal('kanban');
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
    should(store.snapshot()).equal('kanban');
    store.set('list');
    should(store.snapshot()).equal('list');
  });

  test('with no storage at all it starts on the Kanban', () => {
    const store = new BoardSideViewStore(undefined);
    should(store.snapshot()).equal('kanban');
    store.set('list');
    should(store.snapshot()).equal('list');
  });
});
