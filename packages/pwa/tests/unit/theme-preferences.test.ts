import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_THEME_PREFERENCE,
  MANIFEST_LINK_ID,
  TEXT_SCALES,
  TEXT_SCALE_FACTORS,
  THEME_FAMILIES,
  THEME_MODES,
  THEME_PREFERENCES_KEY,
  ThemePreferenceStore,
  type ThemePreferenceStorage,
  applyTextScale,
  manifestHrefFor,
  parseThemePreference,
  resolveThemeMode,
  supportsTextScale,
  themeAttribute,
  themeColorFromComputedStyle,
} from '../../src/lib/theme-preferences.ts';

/** A storage double whose failure modes are the ones browsers actually have. */
const fakeStorage = (
  seed: Record<string, string> = {},
  fail: { read?: boolean; write?: boolean } = {},
): ThemePreferenceStorage & { readonly items: Record<string, string> } => ({
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

describe('theme catalogue', () => {
  it('offers the seven families themes.css declares tokens for, in picker order', () => {
    // Act
    const ids = THEME_FAMILIES.map(family => family.id);

    // Assert
    expect(ids).toEqual([
      'studio',
      'mission',
      'neo',
      'contrast',
      'geist',
      'phosphor',
      'blueprint',
      'broadsheet',
      'wayfinding',
      'ledger',
      'ma',
    ]);
    expect(THEME_FAMILIES.every(family => family.label.length > 0 && family.blurb.length > 0)).toBe(true);
  });

  it('never shrinks the interface, so 44px touch targets keep their floor', () => {
    // Assert
    expect(TEXT_SCALES).toEqual(['default', 'large', 'larger']);
    expect(Math.min(...TEXT_SCALES.map(scale => TEXT_SCALE_FACTORS[scale]))).toBe(1);
    expect(THEME_MODES).toEqual(['system', 'light', 'dark']);
  });
});

describe('parseThemePreference', () => {
  it('treats absent, blank, unparsable and non-object payloads as the house default', () => {
    expect(parseThemePreference(null)).toEqual(DEFAULT_THEME_PREFERENCE);
    expect(parseThemePreference(undefined)).toEqual(DEFAULT_THEME_PREFERENCE);
    expect(parseThemePreference('   ')).toEqual(DEFAULT_THEME_PREFERENCE);
    expect(parseThemePreference('{not json')).toEqual(DEFAULT_THEME_PREFERENCE);
    expect(parseThemePreference('{"x":1}')).toEqual(DEFAULT_THEME_PREFERENCE);
    expect(parseThemePreference('nonsense')).toEqual(DEFAULT_THEME_PREFERENCE);
  });

  it('rejects a JSON array, which parses but is not a preference', () => {
    expect(parseThemePreference('[]')).toEqual(DEFAULT_THEME_PREFERENCE);
  });

  it('reads the current shape whole', () => {
    // Act
    const actual = parseThemePreference('{"family":"phosphor","mode":"dark","textScale":"large"}');

    // Assert
    expect(actual).toEqual({ family: 'phosphor', mode: 'dark', textScale: 'large' });
  });

  it('falls back per field, so one corrupt value never resets the others', () => {
    // Act
    const actual = parseThemePreference('{"family":"geist","mode":"neon","textScale":42}');

    // Assert
    expect(actual).toEqual({ family: 'geist', mode: 'system', textScale: 'default' });
  });

  it('accepts a bare mode, keeping the reader mode and adopting the house family', () => {
    expect(parseThemePreference('dark')).toEqual({ family: 'studio', mode: 'dark', textScale: 'default' });
  });

  it('accepts a bare resolved attribute, the value <html data-theme> itself carries', () => {
    expect(parseThemePreference('mission-dark')).toEqual({ family: 'mission', mode: 'dark', textScale: 'default' });
    expect(parseThemePreference('ledger-light')).toEqual({
      family: 'ledger',
      mode: 'light',
      textScale: 'default',
    });
  });

  it('refuses an attribute whose family or mode is not one we declare tokens for', () => {
    expect(parseThemePreference('vaporwave-dark')).toEqual(DEFAULT_THEME_PREFERENCE);
    expect(parseThemePreference('phosphor-sepia')).toEqual(DEFAULT_THEME_PREFERENCE);
    expect(parseThemePreference('-dark')).toEqual(DEFAULT_THEME_PREFERENCE);
  });
});

describe('resolveThemeMode', () => {
  it('answers `system` with the OS preference and honours an explicit mode against it', () => {
    expect(resolveThemeMode('system', true)).toBe('dark');
    expect(resolveThemeMode('system', false)).toBe('light');
    expect(resolveThemeMode('light', true)).toBe('light');
    expect(resolveThemeMode('dark', false)).toBe('dark');
  });
});

describe('themeAttribute', () => {
  it('publishes family and resolved mode as the one value themes.css and swatches share', () => {
    expect(themeAttribute('neo', 'dark')).toBe('neo-dark');
  });
});

describe('applyTextScale', () => {
  it('scales type without touching the CSS-pixel coordinate system the shell measures in', () => {
    // Arrange
    const root = { dataset: {} as Record<string, string>, style: new FakeStyle() } as unknown as HTMLElement;

    // Act
    applyTextScale(root, 'larger');

    // Assert
    const style = root.style as unknown as FakeStyle;
    expect(root.dataset.textScale).toBe('larger');
    expect(style.properties['text-size-adjust']).toBe('125%');
    expect(style.properties['-webkit-text-size-adjust']).toBe('125%');
    expect(style.removed).toContain('zoom');
  });
});

class FakeStyle {
  readonly properties: Record<string, string> = {};
  readonly removed: string[] = [];
  setProperty(name: string, value: string): void {
    this.properties[name] = value;
  }
  removeProperty(name: string): void {
    this.removed.push(name);
  }
}

describe('supportsTextScale', () => {
  it('requires percentage support, not mere recognition of the property name', () => {
    expect(supportsTextScale(() => false)).toBe(false);
    expect(supportsTextScale((property, value) => property === 'text-size-adjust' && value === '125%')).toBe(true);
    expect(supportsTextScale(property => property === '-webkit-text-size-adjust')).toBe(true);
  });

  it('reports no support when the engine has no CSS.supports at all', () => {
    // Arrange
    const original = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
    Reflect.deleteProperty(globalThis, 'CSS');

    try {
      // Act + Assert
      expect(supportsTextScale()).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, 'CSS', original);
    }
  });

  it('probes the ambient CSS.supports when no probe is injected', () => {
    // Arrange
    const original = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
    Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { supports: () => true } });

    try {
      // Act + Assert
      expect(supportsTextScale()).toBe(true);
    } finally {
      if (original) Object.defineProperty(globalThis, 'CSS', original);
      else Reflect.deleteProperty(globalThis, 'CSS');
    }
  });
});

describe('manifestHrefFor', () => {
  it('swaps only the family+mode segment, preserving the release fingerprint', () => {
    expect(manifestHrefFor('/manifest-studio-light.a1b2c3d4e5f6.webmanifest', 'phosphor', 'dark')).toBe(
      '/manifest-phosphor-dark.a1b2c3d4e5f6.webmanifest',
    );
  });

  it('returns a href it does not recognise unchanged rather than fabricating a URL', () => {
    expect(manifestHrefFor('/manifest.webmanifest', 'neo', 'light')).toBe('/manifest.webmanifest');
    expect(manifestHrefFor('', 'neo', 'light')).toBe('');
  });

  it('names one manifest link so the DOM cannot lie about which manifest is in force', () => {
    expect(MANIFEST_LINK_ID).toBe('fy-manifest');
  });
});

describe('themeColorFromComputedStyle', () => {
  it('reads the window colour from the cascade, never from a colour map in TypeScript', () => {
    // Arrange — the one global the function needs, restored afterwards.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
    Object.defineProperty(globalThis, 'getComputedStyle', {
      configurable: true,
      value: () => ({ getPropertyValue: (name: string) => (name === '--bg' ? '  #101014  ' : '') }),
    });

    try {
      // Act + Assert
      expect(themeColorFromComputedStyle({} as Element)).toBe('#101014');
    } finally {
      if (original) Object.defineProperty(globalThis, 'getComputedStyle', original);
      else Reflect.deleteProperty(globalThis, 'getComputedStyle');
    }
  });
});

describe('ThemePreferenceStore', () => {
  it('hydrates once from storage and keeps the snapshot identity-stable', () => {
    // Arrange
    const storage = fakeStorage({ [THEME_PREFERENCES_KEY]: '{"family":"neo","mode":"light","textScale":"large"}' });
    const store = new ThemePreferenceStore(storage);

    // Act
    const first = store.snapshot();
    const second = store.snapshot();

    // Assert
    expect(first).toEqual({ family: 'neo', mode: 'light', textScale: 'large' });
    expect(second).toBe(first);
  });

  it('persists each change under the sole theme key and notifies subscribers', () => {
    // Arrange
    const storage = fakeStorage();
    const store = new ThemePreferenceStore(storage);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    // Act
    store.setFamily('phosphor');
    store.setMode('dark');
    const actual = store.setTextScale('larger');

    // Assert
    expect(actual).toEqual({ family: 'phosphor', mode: 'dark', textScale: 'larger' });
    expect(JSON.parse(storage.items[THEME_PREFERENCES_KEY] ?? '{}')).toEqual(actual);
    expect(notifications).toBe(3);

    // Act — a released subscriber stops hearing about changes.
    unsubscribe();
    store.setMode('light');

    // Assert
    expect(notifications).toBe(3);
  });

  it('adopts another tab value without writing it back', () => {
    // Arrange
    const storage = fakeStorage();
    const store = new ThemePreferenceStore(storage);

    // Act
    const actual = store.adopt('{"family":"contrast","mode":"dark","textScale":"default"}');

    // Assert
    expect(actual).toEqual({ family: 'contrast', mode: 'dark', textScale: 'default' });
    expect(storage.items[THEME_PREFERENCES_KEY]).toBeUndefined();
  });

  it('keeps the snapshot identity when an adoption changes nothing, so no consumer re-renders', () => {
    // Arrange
    const store = new ThemePreferenceStore(fakeStorage());
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    const before = store.snapshot();

    // Act
    const actual = store.adopt(JSON.stringify(DEFAULT_THEME_PREFERENCE));

    // Assert
    expect(actual).toBe(before);
    expect(notifications).toBe(0);
  });

  it('falls back to the house default when a read is denied', () => {
    // Arrange
    const store = new ThemePreferenceStore(fakeStorage({}, { read: true }));

    // Act + Assert
    expect(store.snapshot()).toEqual(DEFAULT_THEME_PREFERENCE);
  });

  it('keeps applying a theme for the rest of the tab when the write is refused', () => {
    // Arrange
    const store = new ThemePreferenceStore(fakeStorage({}, { write: true }));

    // Act
    const actual = store.setFamily('geist');

    // Assert
    expect(actual.family).toBe('geist');
    expect(store.snapshot().family).toBe('geist');
  });

  it('works with no storage at all, as a private-mode browser has', () => {
    // Arrange
    const store = new ThemePreferenceStore(undefined);

    // Act
    const actual = store.setMode('dark');

    // Assert
    expect(actual.mode).toBe('dark');
    expect(store.snapshot()).toEqual({ family: 'studio', mode: 'dark', textScale: 'default' });
  });

  it('ignores a `localStorage` that is present but is not a Storage', () => {
    // Act
    const store = withGlobalStorage({ value: { nope: true } }, () => new ThemePreferenceStore());

    // Assert
    expect(store.snapshot()).toEqual(DEFAULT_THEME_PREFERENCE);
  });

  it('survives a `localStorage` getter that throws, as a blocked-cookies browser does', () => {
    // Act
    const store = withGlobalStorage(
      {
        get() {
          throw new Error('access denied');
        },
      },
      () => new ThemePreferenceStore(),
    );

    // Assert
    expect(store.snapshot()).toEqual(DEFAULT_THEME_PREFERENCE);
  });

  it('adopts the ambient localStorage when one is not injected', () => {
    // Arrange
    const items: Record<string, string> = { [THEME_PREFERENCES_KEY]: '{"family":"phosphor","mode":"light"}' };

    // Act
    const store = withGlobalStorage(
      { value: { getItem: (key: string) => items[key] ?? null, setItem: () => {} } },
      () => new ThemePreferenceStore(),
    );

    // Assert
    expect(store.snapshot()).toEqual({ family: 'phosphor', mode: 'light', textScale: 'default' });
  });
});
