import { afterEach, describe, expect, it } from 'bun:test';
import { useTheme, type ThemeState, themePreferences } from '../../src/hooks/use-theme.ts';
import {
  MANIFEST_LINK_ID,
  THEME_PREFERENCES_KEY,
  ThemePreferenceStore,
  type ThemePreferenceStorage,
} from '../../src/lib/theme-preferences.ts';
import { interact, mount } from '../support/dom.ts';

const memoryStorage = (seed: Record<string, string> = {}): ThemePreferenceStorage => ({
  getItem: key => seed[key] ?? null,
  setItem: (key, value) => {
    seed[key] = value;
  },
});

type MediaListener = (event: MediaQueryListEvent) => void;

const mediaListeners = new Set<MediaListener>();
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const originalComputedStyle = Object.getOwnPropertyDescriptor(window, 'getComputedStyle');

/** A `prefers-color-scheme` this suite flips by hand. */
const installMatchMedia = (matches: boolean): void => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({
      matches,
      addEventListener: (_: string, listener: MediaListener) => mediaListeners.add(listener),
      removeEventListener: (_: string, listener: MediaListener) => mediaListeners.delete(listener),
    }),
  });
};

const flipOsTo = async (dark: boolean): Promise<void> => {
  await interact(() => {
    for (const listener of mediaListeners) listener({ matches: dark } as MediaQueryListEvent);
  });
};

/** happy-dom resolves `--bg` to nothing; give the effect a real colour to read. */
const installComputedStyle = (bg: string): void => {
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    writable: true,
    value: () => ({ getPropertyValue: (name: string) => (name === '--bg' ? bg : '') }),
  });
};

let captured: ThemeState | null = null;

const Probe = ({ store }: { store?: ThemePreferenceStore }) => {
  captured = useTheme(store);
  return <span data-attr={captured.attr} data-scale={captured.textScale} />;
};

const attrOf = (container: HTMLElement): string | null =>
  container.querySelector('span')?.getAttribute('data-attr') ?? null;

const theme = (): ThemeState => {
  if (!captured) throw new Error('the probe never rendered');
  return captured;
};

afterEach(() => {
  mediaListeners.clear();
  captured = null;
  document.getElementById(MANIFEST_LINK_ID)?.remove();
  document.querySelector('meta[name="theme-color"]')?.remove();
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
  if (originalComputedStyle) Object.defineProperty(window, 'getComputedStyle', originalComputedStyle);
});

describe('useTheme', () => {
  it('publishes the resolved family+mode on the root and follows the OS live', async () => {
    // Arrange
    installMatchMedia(false);
    const store = new ThemePreferenceStore(memoryStorage());

    // Act
    const view = await mount(<Probe store={store} />);

    // Assert — `system` on a light OS.
    expect(attrOf(view.container)).toBe('studio-light');
    expect(document.documentElement.dataset.theme).toBe('studio-light');
    expect(theme().resolved).toBe('light');

    // Act — the OS flips while the reader is still on Auto.
    await flipOsTo(true);

    // Assert
    expect(attrOf(view.container)).toBe('studio-dark');
    expect(document.documentElement.dataset.theme).toBe('studio-dark');

    await view.unmount();
  });

  it('lets an explicit mode override the OS, and persists both halves of the choice', async () => {
    // Arrange
    installMatchMedia(true);
    const items: Record<string, string> = {};
    const store = new ThemePreferenceStore(memoryStorage(items));
    const view = await mount(<Probe store={store} />);

    // Act
    await interact(() => theme().setMode('light'));
    await interact(() => theme().setFamily('ember'));

    // Assert
    expect(attrOf(view.container)).toBe('ember-light');
    expect(JSON.parse(items[THEME_PREFERENCES_KEY] ?? '{}')).toEqual({
      family: 'ember',
      mode: 'light',
      textScale: 'default',
    });

    // Act — the OS flip is now irrelevant.
    await flipOsTo(false);

    // Assert
    expect(attrOf(view.container)).toBe('ember-light');
    await view.unmount();
  });

  it('applies the text scale only when the engine really supports percentages', async () => {
    // Arrange
    installMatchMedia(false);
    const originalCss = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
    Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { supports: () => false } });
    const store = new ThemePreferenceStore(memoryStorage());

    try {
      const view = await mount(<Probe store={store} />);

      // Act — refused, because persisting it would enlarge a browser that CAN.
      await interact(() => theme().setTextScale('larger'));

      // Assert
      expect(theme().textScaleSupported).toBe(false);
      expect(theme().textScale).toBe('default');
      expect(document.documentElement.dataset.textScale).toBe('default');
      await view.unmount();

      // Arrange — the same reader on an engine that supports it.
      Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { supports: () => true } });
      const supported = await mount(<Probe store={store} />);

      // Act
      await interact(() => theme().setTextScale('large'));

      // Assert
      expect(theme().textScaleSupported).toBe(true);
      expect(document.documentElement.dataset.textScale).toBe('large');
      expect(document.documentElement.style.getPropertyValue('text-size-adjust')).toBe('112.5%');
      await supported.unmount();
    } finally {
      if (originalCss) Object.defineProperty(globalThis, 'CSS', originalCss);
      else Reflect.deleteProperty(globalThis, 'CSS');
    }
  });

  it('repoints the one manifest link and writes the window colour, without re-fetching on a no-op', async () => {
    // Arrange
    installMatchMedia(false);
    installComputedStyle('#0b0b0f');
    const link = document.createElement('link');
    link.id = MANIFEST_LINK_ID;
    link.rel = 'manifest';
    link.href = '/manifest-studio-light.abc123abc123.webmanifest';
    document.head.appendChild(link);
    const writes: string[] = [];
    const observer = new MutationObserver(() => writes.push(link.getAttribute('href') ?? ''));
    observer.observe(link, { attributes: true, attributeFilter: ['href'] });

    const store = new ThemePreferenceStore(memoryStorage());
    const view = await mount(<Probe store={store} />);

    // Assert — mounting on the family the href already names writes nothing.
    expect(link.getAttribute('href')).toBe('/manifest-studio-light.abc123abc123.webmanifest');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#0b0b0f');

    // Act
    await interact(() => theme().setFamily('neo'));
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    // Assert — the release fingerprint survived the swap.
    expect(link.getAttribute('href')).toBe('/manifest-neo-light.abc123abc123.webmanifest');
    expect(writes).toEqual(['/manifest-neo-light.abc123abc123.webmanifest']);

    observer.disconnect();
    link.remove();
    await view.unmount();
  });

  it('reuses an existing theme-color meta rather than appending a second one', async () => {
    // Arrange
    installMatchMedia(false);
    installComputedStyle('#ffffff');
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#000000';
    document.head.appendChild(meta);

    // Act
    const view = await mount(<Probe store={new ThemePreferenceStore(memoryStorage())} />);

    // Assert
    expect(document.querySelectorAll('meta[name="theme-color"]').length).toBe(1);
    expect(meta.content).toBe('#ffffff');
    meta.remove();
    await view.unmount();
  });

  it('adopts a theme another tab wrote, and ignores every other storage key', async () => {
    // Arrange
    installMatchMedia(false);
    const store = new ThemePreferenceStore(memoryStorage());
    const view = await mount(<Probe store={store} />);

    // Act
    await interact(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'fy-side-pane-v1', newValue: '{"v":1,"width":900}' }));
    });

    // Assert
    expect(attrOf(view.container)).toBe('studio-light');

    // Act
    await interact(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: THEME_PREFERENCES_KEY,
          newValue: '{"family":"notebook","mode":"dark","textScale":"default"}',
        }),
      );
    });

    // Assert
    expect(attrOf(view.container)).toBe('notebook-dark');

    // Act — after unmount the listener is gone and the tab stops reacting.
    await view.unmount();
    const seen = attrOf(view.container);
    window.dispatchEvent(
      new StorageEvent('storage', { key: THEME_PREFERENCES_KEY, newValue: '{"family":"geist","mode":"light"}' }),
    );
    expect(attrOf(view.container)).toBe(seen);
  });

  it('renders on an engine with no matchMedia at all, defaulting `system` to light', async () => {
    // Arrange
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');

    // Act
    const view = await mount(<Probe store={new ThemePreferenceStore(memoryStorage())} />);

    // Assert
    expect(attrOf(view.container)).toBe('studio-light');
    await view.unmount();
  });

  it('shares one tab-wide store when no store is injected', async () => {
    // Arrange
    installMatchMedia(false);

    // Act
    const view = await mount(<Probe />);

    // Assert
    expect(theme().family).toBe(themePreferences.snapshot().family);
    await view.unmount();
  });
});
