import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SIDE_PANE_PREFERENCES,
  SIDE_PANE_DEFAULT_WIDTH,
  SIDE_PANE_MAX_WIDTH,
  SIDE_PANE_MIN_WIDTH,
  SIDE_PANE_PREFERENCES_KEY,
  SIDE_PANE_PREFERENCES_VERSION,
  SidePanePreferenceStore,
  type SidePanePreferenceStorage,
  clampSidePaneWidth,
  parseSidePanePreferences,
} from '../../src/lib/side-pane-preferences.ts';

/** A storage double whose failure modes are the ones browsers actually have. */
const fakeStorage = (
  seed: Record<string, string> = {},
  fail: { read?: boolean; write?: boolean } = {},
): SidePanePreferenceStorage & { readonly items: Record<string, string> } => ({
  items: seed,
  getItem(key) {
    if (fail.read) throw new Error('storage denied');
    return seed[key] ?? null;
  },
  setItem(key, value) {
    if (fail.write) throw new Error('quota exceeded');
    seed[key] = value;
  },
});

/** Swaps `globalThis.localStorage` for the duration of one call. */
const withGlobalStorage = <T>(descriptor: PropertyDescriptor | null, body: () => T): T => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (descriptor) Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...descriptor });
  else Reflect.deleteProperty(globalThis, 'localStorage');
  try {
    return body();
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
};

describe('clampSidePaneWidth', () => {
  it('falls back to the default width for anything that is not a finite number', () => {
    expect(clampSidePaneWidth(Number.NaN)).toBe(SIDE_PANE_DEFAULT_WIDTH);
    expect(clampSidePaneWidth(Number.POSITIVE_INFINITY)).toBe(SIDE_PANE_DEFAULT_WIDTH);
  });

  it('clamps to the absolute desktop bounds and rounds to whole pixels', () => {
    expect(clampSidePaneWidth(10)).toBe(SIDE_PANE_MIN_WIDTH);
    expect(clampSidePaneWidth(99_999)).toBe(SIDE_PANE_MAX_WIDTH);
    expect(clampSidePaneWidth(520.6)).toBe(521);
  });
});

describe('parseSidePanePreferences', () => {
  it('treats absent, unparsable and non-object payloads as a clean reset', () => {
    expect(parseSidePanePreferences(null)).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
    expect(parseSidePanePreferences('')).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
    expect(parseSidePanePreferences('{ not json')).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
    expect(parseSidePanePreferences('null')).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
    expect(parseSidePanePreferences('7')).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
    expect(parseSidePanePreferences('[{"v":1,"width":700}]')).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
  });

  it('resets on an unknown payload version rather than guessing at its shape', () => {
    expect(parseSidePanePreferences(JSON.stringify({ v: 99, width: 700 }))).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
  });

  it('falls back per field, so a bad width does not discard a valid payload', () => {
    expect(parseSidePanePreferences(JSON.stringify({ v: 1, width: 'wide' }))).toEqual({
      v: SIDE_PANE_PREFERENCES_VERSION,
      width: SIDE_PANE_DEFAULT_WIDTH,
    });
  });

  it('accepts a valid payload, clamps it, and ignores unknown fields', () => {
    expect(parseSidePanePreferences(JSON.stringify({ v: 1, width: 4_000, surface: 'files' }))).toEqual({
      v: SIDE_PANE_PREFERENCES_VERSION,
      width: SIDE_PANE_MAX_WIDTH,
    });
  });
});

describe('SidePanePreferenceStore', () => {
  it('hydrates once from storage and keeps the snapshot identity stable', () => {
    const store = new SidePanePreferenceStore(fakeStorage({ [SIDE_PANE_PREFERENCES_KEY]: '{"v":1,"width":640}' }));

    const first = store.snapshot();

    expect(first.width).toBe(640);
    expect(store.snapshot()).toBe(first);
  });

  it('persists a committed width and notifies every live subscriber exactly once', () => {
    const storage = fakeStorage();
    const store = new SidePanePreferenceStore(storage);
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });

    expect(store.setWidth(700.4)).toEqual({ v: SIDE_PANE_PREFERENCES_VERSION, width: 700 });
    expect(notified).toBe(1);
    expect(storage.items[SIDE_PANE_PREFERENCES_KEY]).toBe('{"v":1,"width":700}');
    expect(store.snapshot().width).toBe(700);

    unsubscribe();
    store.setWidth(680);

    expect(notified).toBe(1);
  });

  it('treats a denied read as an ordinary browser condition', () => {
    const store = new SidePanePreferenceStore(fakeStorage({}, { read: true }));

    expect(store.snapshot()).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
  });

  it('keeps resizing after a denied write; the preference still applies in memory', () => {
    const store = new SidePanePreferenceStore(fakeStorage({}, { write: true }));

    expect(store.setWidth(700).width).toBe(700);
    expect(store.snapshot().width).toBe(700);
  });

  it('runs without any storage at all, in memory only', () => {
    const store = withGlobalStorage(null, () => new SidePanePreferenceStore());

    expect(store.snapshot()).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
    expect(store.setWidth(700).width).toBe(700);
    expect(store.snapshot().width).toBe(700);
  });

  it('ignores a `localStorage` that is present but not a Storage', () => {
    const store = withGlobalStorage({ value: { getItem: 'not a function' } }, () => new SidePanePreferenceStore());

    expect(store.setWidth(700).width).toBe(700);
  });

  it('survives a `localStorage` getter that throws, as a blocked-cookies browser does', () => {
    const store = withGlobalStorage(
      {
        get() {
          throw new Error('access denied');
        },
      },
      () => new SidePanePreferenceStore(),
    );

    expect(store.snapshot()).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
  });

  it('adopts the ambient localStorage when one is not injected', () => {
    const storage = fakeStorage({ [SIDE_PANE_PREFERENCES_KEY]: '{"v":1,"width":640}' });
    const store = withGlobalStorage({ value: storage }, () => new SidePanePreferenceStore());

    expect(store.snapshot().width).toBe(640);
  });
});
