import { afterEach, describe, test } from 'bun:test';
import should from 'should';
import {
  DISMISSED_SEND_LIFETIME_MS,
  EMPTY_SEND_VIEW,
  MAX_DISMISSED_SENDS,
  newestDismissed,
  parseDismissed,
  SEND_DISMISSALS_KEY,
  SEND_DISMISSALS_VERSION,
  type SendDismissalStorage,
  SendDismissalStore,
} from '../../src/lib/send-dismissals.ts';

const NOW = Date.parse('2026-10-21T09:00:00.000Z');

const memory = (seed: Record<string, string> = {}): SendDismissalStorage & { readonly values: Map<string, string> } => {
  const values = new Map(Object.entries(seed));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

const stored = (dismissed: Record<string, unknown>, v: number = SEND_DISMISSALS_VERSION): string =>
  JSON.stringify({ v, dismissed });

describe('parseDismissed', () => {
  test('reads what was written and keeps only dismissals younger than the lifetime', () => {
    // Arrange
    const raw = stored({
      fresh: NOW - 1_000,
      stale: NOW - DISMISSED_SEND_LIFETIME_MS,
      edge: NOW - DISMISSED_SEND_LIFETIME_MS + 1,
    });
    // Act
    const actual = parseDismissed(raw, NOW);
    // Assert
    should(actual).eql({ fresh: NOW - 1_000, edge: NOW - DISMISSED_SEND_LIFETIME_MS + 1 });
  });

  test('resets anything unreadable to nothing dismissed', () => {
    const subjects: (string | null | undefined)[] = [
      undefined,
      null,
      '',
      'not json',
      'null',
      '7',
      JSON.stringify({ v: 2, dismissed: { a: NOW } }),
      JSON.stringify({ v: SEND_DISMISSALS_VERSION }),
      JSON.stringify({ v: SEND_DISMISSALS_VERSION, dismissed: null }),
      JSON.stringify({ v: SEND_DISMISSALS_VERSION, dismissed: 'a' }),
    ];
    for (const input of subjects) should(parseDismissed(input, NOW)).eql({});
  });

  test('drops entries with an empty id or a value that is not an instant', () => {
    const input = stored({ '': NOW, text: 'yesterday', missing: null, ok: NOW });
    should(parseDismissed(input, NOW)).eql({ ok: NOW });
  });
});

describe('newestDismissed', () => {
  test('returns the same record while it fits, and otherwise keeps the newest', () => {
    const small = { a: 1, b: 2, c: 3 };
    should(newestDismissed(small)).equal(small);
    should(newestDismissed(small, 2)).eql({ b: 2, c: 3 });
    const many = Object.fromEntries(Array.from({ length: MAX_DISMISSED_SENDS + 5 }, (_, i) => [`s${i}`, i]));
    const kept = newestDismissed(many);
    should(Object.keys(kept)).have.length(MAX_DISMISSED_SENDS);
    should(kept.s0).equal(undefined);
    should(kept[`s${MAX_DISMISSED_SENDS + 4}`]).equal(MAX_DISMISSED_SENDS + 4);
  });
});

describe('SendDismissalStore', () => {
  test('starts empty, remembers a dismissal on this device and tells every listener once', () => {
    const storage = memory();
    const store = new SendDismissalStore(storage, () => NOW);
    should(store.snapshot()).equal(store.snapshot());
    should([...store.snapshot().dismissed]).eql([]);
    let heard = 0;
    const unsubscribe = store.subscribe(() => {
      heard += 1;
    });
    store.dismiss(['a', 'b']);
    should([...store.snapshot().dismissed].sort()).eql(['a', 'b']);
    should(JSON.parse(storage.values.get(SEND_DISMISSALS_KEY) ?? '')).eql({
      v: SEND_DISMISSALS_VERSION,
      dismissed: { a: NOW, b: NOW },
    });
    should(heard).equal(1);
    unsubscribe();
    store.dismiss(['c']);
    should(heard).equal(1);
  });

  test('hydrates earlier dismissals, and dismissing what is already dismissed or empty changes nothing', () => {
    const storage = memory({ [SEND_DISMISSALS_KEY]: stored({ old: NOW - 5 }) });
    const store = new SendDismissalStore(storage, () => NOW);
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    store.dismiss(['old', '']);
    store.dismiss([]);
    should(heard).equal(0);
    should(storage.values.get(SEND_DISMISSALS_KEY)).equal(stored({ old: NOW - 5 }));
    store.dismiss(['new']);
    should(JSON.parse(storage.values.get(SEND_DISMISSALS_KEY) ?? '').dismissed).eql({ old: NOW - 5, new: NOW });
  });

  test('opening a note is remembered for the tab only, and dismissing it closes it', () => {
    const storage = memory();
    const store = new SendDismissalStore(storage, () => NOW);
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    store.setExpanded('a', true);
    store.setExpanded('a', true);
    should([...store.snapshot().expanded]).eql(['a']);
    should(heard).equal(1);
    should(storage.values.size).equal(0);
    store.setExpanded('b', true);
    store.setExpanded('b', false);
    should([...store.snapshot().expanded]).eql(['a']);
    store.dismiss(['a']);
    should([...store.snapshot().expanded]).eql([]);
    should(store.snapshot().dismissed.has('a')).equal(true);
  });

  test('a denied storage still dismisses for the rest of the tab', () => {
    const denied: SendDismissalStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const store = new SendDismissalStore(denied, () => NOW);
    should([...store.snapshot().dismissed]).eql([]);
    store.dismiss(['a']);
    should(store.snapshot().dismissed.has('a')).equal(true);
  });
});

describe('the browser default', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const install = (value: unknown): void => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
  };

  test('reads and writes the real storage when there is one', () => {
    const storage = memory({ [SEND_DISMISSALS_KEY]: stored({ kept: NOW }) });
    install(storage);
    const store = new SendDismissalStore(undefined, () => NOW);
    should(store.snapshot().dismissed.has('kept')).equal(true);
    store.dismiss(['more']);
    should(storage.values.get(SEND_DISMISSALS_KEY)).equal(stored({ kept: NOW, more: NOW }));
  });

  test('has no storage when the browser lacks it, offers an unusable one, or throws on touching it', () => {
    for (const candidate of [undefined, {}, { getItem: () => null }]) {
      install(candidate);
      const store = new SendDismissalStore(undefined, () => NOW);
      store.dismiss(['a']);
      should(store.snapshot().dismissed.has('a')).equal(true);
    }
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('blocked');
      },
    });
    const blocked = new SendDismissalStore(undefined, () => NOW);
    blocked.dismiss(['a']);
    should(blocked.snapshot().dismissed.has('a')).equal(true);
  });

  test('the empty view dismisses and opens nothing', () => {
    should(EMPTY_SEND_VIEW.dismissed.size).equal(0);
    should(EMPTY_SEND_VIEW.expanded.size).equal(0);
  });
});
