import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { APP_STORAGE, databaseName, localKey, speechModelCache } from '../../src/storage/names.ts';
import { memoryStore, readRecord, writeRecord } from '../../src/storage/records.ts';
import { DEFAULT_THEME_PREFERENCE, ThemePreferenceStore } from '../../src/theme/preferences.ts';
import { applyThemeItem, ThemeItemSchema, themeProperties } from '../../src/theme/tokens.ts';

describe('browser storage names (§9.4)', () => {
  test('keys are fy:<id>:<name> with no version in the name', () => {
    expect(localKey('board', 'private-view')).toBe('fy:board:private-view');
    expect(localKey('access', 'devices-seen', 'd1')).toBe('fy:access:devices-seen:d1');
    expect(APP_STORAGE.trail).toBe('fy:app:trail');
    expect(APP_STORAGE.scroll).toBe('fy:app:scroll');
    expect(databaseName('access')).toBe('fy-access');
    expect(speechModelCache('whisper-tiny')).toBe('fy:voice:whisper-tiny');
  });

  test('a malformed owner or name is refused', () => {
    expect(() => localKey('Board', 'x')).toThrow();
    expect(() => localKey('board', 'x-v1:')).toThrow();
  });
});

describe('records', () => {
  const Schema = z.strictObject({ n: z.number() });

  test('round-trips as { format: 1, value }', () => {
    const store = memoryStore();
    writeRecord(store, 'fy:app:x', { n: 1 });
    expect(JSON.parse(store.entries()['fy:app:x'] ?? '')).toEqual({ format: 1, value: { n: 1 } });
    expect(readRecord(store, 'fy:app:x', Schema)).toEqual({ n: 1 });
  });

  test('another format, bad JSON or a refused body reads as absent', () => {
    const store = memoryStore({
      a: JSON.stringify({ format: 2, value: { n: 1 } }),
      b: '{',
      c: JSON.stringify({ format: 1, value: { n: 'one' } }),
    });
    expect(readRecord(store, 'a', Schema)).toBeUndefined();
    expect(readRecord(store, 'b', Schema)).toBeUndefined();
    expect(readRecord(store, 'c', Schema)).toBeUndefined();
    expect(readRecord(null, 'a', Schema)).toBeUndefined();
  });

  test('a store that throws never breaks the caller', () => {
    const angry = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {},
    };
    expect(readRecord(angry, 'a', Schema)).toBeUndefined();
    expect(writeRecord(angry, 'a', { n: 1 })).toBe(false);
  });
});

describe('theme preference', () => {
  test('starts at the default and persists a change under fy:app:theme', () => {
    const store = memoryStore();
    const themes = new ThemePreferenceStore(store);
    expect(themes.snapshot()).toEqual(DEFAULT_THEME_PREFERENCE);
    themes.setFamily('mission');
    themes.setMode('dark');
    expect(new ThemePreferenceStore(store).snapshot()).toEqual({ family: 'mission', mode: 'dark', textScale: 'default' });
  });

  test('an unknown family falls back on its own and keeps the other fields', () => {
    const store = memoryStore({
      [APP_STORAGE.theme]: JSON.stringify({ format: 1, value: { family: 'ember', mode: 'dark', textScale: 'large' } }),
    });
    expect(new ThemePreferenceStore(store).snapshot()).toEqual({ family: 'studio', mode: 'dark', textScale: 'large' });
  });

  test('an old key is never read', () => {
    const store = memoryStore({ 'fy-theme-v1': JSON.stringify({ family: 'mission', mode: 'dark' }) });
    expect(new ThemePreferenceStore(store).snapshot()).toEqual(DEFAULT_THEME_PREFERENCE);
  });

  test('adopting an unchanged value keeps the snapshot identity', () => {
    const themes = new ThemePreferenceStore(memoryStore());
    const before = themes.snapshot();
    expect(themes.adopt()).toBe(before);
  });
});

describe('theme items', () => {
  const item = ThemeItemSchema.parse({
    id: 'dusk',
    label: 'Dusk',
    base: 'studio',
    dark: { accent: '#ff8800', 'card-radius': '12px', 'font-body': "'Inter', sans-serif" },
  });

  test('tokens become custom properties for the resolved mode', () => {
    expect(themeProperties(item, 'dark')).toEqual({
      '--accent': '#ff8800',
      '--font-body': "'Inter', sans-serif",
      '--card-radius': '12px',
    });
    expect(themeProperties(item, 'light')).toEqual({});
  });

  test('an unknown token or an unsafe value is refused', () => {
    expect(ThemeItemSchema.safeParse({ id: 'x', label: 'X', base: 'studio', dark: { position: 'fixed' } }).success).toBe(
      false,
    );
    for (const value of ['red; } body { display: none', 'url(https://example.com/x.png)', 'expression(alert(1))']) {
      expect(ThemeItemSchema.safeParse({ id: 'x', label: 'X', base: 'studio', dark: { accent: value } }).success).toBe(
        false,
      );
    }
  });

  test('applying removes what the item does not set', () => {
    const set = new Map<string, string>([['--fg', 'old']]);
    const root = {
      style: {
        setProperty: (name: string, value: string) => void set.set(name, value),
        removeProperty: (name: string) => void set.delete(name),
      },
    };
    applyThemeItem(root, item, 'dark');
    expect(Object.fromEntries(set)).toEqual(themeProperties(item, 'dark'));
    applyThemeItem(root, undefined, 'dark');
    expect(set.size).toBe(0);
  });
});
