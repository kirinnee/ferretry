import { afterEach, describe, expect, it } from 'bun:test';
import { escapeLayerCount, pushEscapeLayer } from '../../src/hooks/use-dialog-focus.ts';
import { KEYBOARD_ATTRIBUTE } from '../../src/hooks/use-keyboard-open.ts';
import { useTheme, type ThemeState } from '../../src/hooks/use-theme.ts';
import { ThemePreferenceStore, type ThemePreferenceStorage } from '../../src/lib/theme-preferences.ts';
import {
  THEME_FAMILY_CARD_CLASS,
  ThemeSettings,
  ThemeToggle,
  closeThemePopoverForKeyboard,
  scrollThemeFamilyIntoView,
} from '../../src/shell/theme-toggle.tsx';
import { interact, mount, pressKey } from '../support/dom.ts';

const memoryStorage = (seed: Record<string, string> = {}): ThemePreferenceStorage => ({
  getItem: key => seed[key] ?? null,
  setItem: (key, value) => {
    seed[key] = value;
  },
});

type MediaListener = (event: MediaQueryListEvent) => void;

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const originalRaf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');

const installMatchMedia = (): void => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({
      matches: false,
      addEventListener: (_: string, __: MediaListener) => {},
      removeEventListener: (_: string, __: MediaListener) => {},
    }),
  });
};

/**
 * `useKeyboardOpen` answers through a MutationObserver, whose callback is a
 * microtask the test cannot await directly — and under coverage instrumentation
 * one turn of the loop is not always enough. Settle until the condition holds
 * rather than guessing a number of turns.
 */
const settle = async (until: () => boolean, turns = 20): Promise<void> => {
  for (let turn = 0; turn < turns && !until(); turn++) {
    await interact(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  }
};

const trigger = (container: HTMLElement): HTMLButtonElement => {
  const button = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  if (!button) throw new Error('the theme trigger did not render');
  return button;
};

const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Theme"]');

const familyControls = (): HTMLInputElement[] => [...document.querySelectorAll<HTMLInputElement>('input[data-family]')];

const familyCards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-family-card]')];

const checkedFamily = (): string | undefined => familyControls().find(input => input.checked)?.dataset.family;

const familyList = (): HTMLElement => {
  const found = familyControls()[0]?.closest<HTMLElement>('[role="radiogroup"]');
  if (!found) throw new Error('the family list did not render');
  return found;
};

const modeControl = (id: string): HTMLInputElement => {
  const found = document.querySelector<HTMLInputElement>(`input[data-mode="${id}"]`);
  if (!found) throw new Error(`no mode control for ${id}`);
  return found;
};

afterEach(() => {
  document.documentElement.removeAttribute(KEYBOARD_ATTRIBUTE);
  document.querySelector('meta[name="theme-color"]')?.remove();
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
  if (originalRaf) Object.defineProperty(globalThis, 'requestAnimationFrame', originalRaf);
});

describe('scrollThemeFamilyIntoView', () => {
  const scroller = (top: number, bottom: number, scrollTop = 0) =>
    ({ scrollTop, getBoundingClientRect: () => ({ top, bottom }) }) as unknown as HTMLElement;
  const card = (top: number, bottom: number) =>
    ({ getBoundingClientRect: () => ({ top, bottom }) }) as unknown as HTMLElement;

  it('pulls a card that sits above the scrollport back down to its top edge', () => {
    // Arrange
    const view = scroller(100, 400, 250);

    // Act
    scrollThemeFamilyIntoView(view, card(60, 120));

    // Assert
    expect(view.scrollTop).toBe(210);
  });

  it('pushes a card that overhangs the bottom edge up by exactly the overhang', () => {
    // Arrange
    const view = scroller(100, 400, 0);

    // Act
    scrollThemeFamilyIntoView(view, card(380, 460));

    // Assert
    expect(view.scrollTop).toBe(60);
  });

  it('leaves a fully visible card alone rather than moving the app shell', () => {
    // Arrange
    const view = scroller(100, 400, 33);

    // Act
    scrollThemeFamilyIntoView(view, card(150, 220));

    // Assert
    expect(view.scrollTop).toBe(33);
  });
});

describe('closeThemePopoverForKeyboard', () => {
  it('closes WITHOUT returning focus, because the trigger may be about to be hidden', () => {
    // Arrange
    const seen: boolean[] = [];

    // Act
    closeThemePopoverForKeyboard(returnFocus => seen.push(returnFocus));

    // Assert
    expect(seen).toEqual([false]);
  });
});

describe('ThemeSettings', () => {
  const Harness = ({ constrained, store }: { constrained?: boolean; store: ThemePreferenceStore }) => {
    const theme: ThemeState = useTheme(store);
    return (
      <div data-settings-scroller>
        <ThemeSettings theme={theme} constrained={constrained} />
      </div>
    );
  };

  it('renders one card per family, each previewing its own light and dark tokens', async () => {
    // Arrange
    installMatchMedia();

    // Act
    const view = await mount(<Harness store={new ThemePreferenceStore(memoryStorage())} />);

    // Assert
    expect(familyControls().length).toBe(7);
    expect(checkedFamily()).toBe('studio');
    const swatches = [...document.querySelectorAll('[data-swatch]')].map(node => node.getAttribute('data-swatch'));
    expect(swatches.slice(0, 4)).toEqual(['studio-light', 'studio-dark', 'mission-light', 'mission-dark']);
    // The current family+mode pair is ringed, and only that one.
    expect(document.querySelectorAll('.ring-accent').length).toBe(1);
    expect(familyCards()[0]?.className).toContain(THEME_FAMILY_CARD_CLASS);

    await view.unmount();
  });

  it('parks every unchecked family at tabIndex -1, so Tab visits the roving stop only', async () => {
    // Arrange
    installMatchMedia();
    const view = await mount(<Harness store={new ThemePreferenceStore(memoryStorage())} />);

    // Assert
    expect(familyControls().map(input => input.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);
    await view.unmount();
  });

  it('moves the family selection with the arrow keys, Home and End', async () => {
    // Arrange
    installMatchMedia();
    let frames = 0;
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => {
        frames += 1;
        callback(0);
        return frames;
      },
    });
    const view = await mount(<Harness store={new ThemePreferenceStore(memoryStorage())} />);
    const list = familyList();

    // Act
    await interact(() => pressKey(list, 'ArrowDown'));

    // Assert
    expect(checkedFamily()).toBe('mission');

    // Act
    await interact(() => pressKey(list, 'End'));

    // Assert
    expect(checkedFamily()).toBe('geist');

    // Act — End again cannot walk past the last card.
    await interact(() => pressKey(list, 'ArrowRight'));

    // Assert
    expect(checkedFamily()).toBe('geist');

    // Act
    await interact(() => pressKey(list, 'ArrowUp'));
    await interact(() => pressKey(list, 'Home'));

    // Assert
    expect(checkedFamily()).toBe('studio');

    // Act — Home again cannot walk past the first card.
    await interact(() => pressKey(list, 'ArrowLeft'));

    // Assert
    expect(checkedFamily()).toBe('studio');

    // Act — an unrelated key is not the list's business.
    await interact(() => pressKey(list, 'a'));

    // Assert
    expect(checkedFamily()).toBe('studio');
    expect(frames).toBeGreaterThan(0);

    await view.unmount();
  });

  it('reveals the focused card inside the page scrollport when it is not a popover', async () => {
    // Arrange — an unconstrained section scrolls its `[data-settings-scroller]`.
    installMatchMedia();
    const view = await mount(<Harness store={new ThemePreferenceStore(memoryStorage())} />);
    const list = familyList();
    const scroller = document.querySelector<HTMLElement>('[data-settings-scroller]');
    if (!scroller) throw new Error('the settings scroller did not render');
    scroller.getBoundingClientRect = () => ({ top: 100, bottom: 200 }) as DOMRect;

    // Act
    await interact(() => pressKey(list, 'End'));

    // Assert — the reveal ran against the page scroller, not the list.
    expect(checkedFamily()).toBe('geist');
    await view.unmount();
  });

  it('caps its own height only when it is a popover', async () => {
    // Arrange
    installMatchMedia();

    // Act
    const constrained = await mount(<Harness constrained store={new ThemePreferenceStore(memoryStorage())} />);
    const capped = familyList().className;
    await constrained.unmount();
    const flat = await mount(<Harness store={new ThemePreferenceStore(memoryStorage())} />);
    const uncapped = familyList().className;

    // Assert
    expect(capped).toContain('overflow-y-auto');
    expect(uncapped).not.toContain('overflow-y-auto');
    await flat.unmount();
  });

  it('switches the colour mode from the Auto / Light / Dark control', async () => {
    // Arrange
    installMatchMedia();
    const view = await mount(<Harness store={new ThemePreferenceStore(memoryStorage())} />);

    // Act
    await interact(() => modeControl('dark').click());

    // Assert
    expect(modeControl('dark').checked).toBe(true);
    expect(modeControl('system').checked).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('studio-dark');

    await view.unmount();
  });
});

describe('ThemeToggle', () => {
  const open = async (container: HTMLElement): Promise<void> => {
    await interact(() => trigger(container).click());
  };

  it('summarises the theme in force on its trigger, naming the resolved mode under Auto', async () => {
    // Arrange
    installMatchMedia();
    const store = new ThemePreferenceStore(memoryStorage());
    const view = await mount(<ThemeToggle store={store} />);

    // Assert
    expect(trigger(view.container).getAttribute('aria-label')).toBe('Theme: Studio, Auto (light)');
    expect(trigger(view.container).getAttribute('aria-expanded')).toBe('false');
    expect(trigger(view.container).getAttribute('aria-controls')).toBeNull();
    expect(panel()).toBeNull();

    // Act
    await open(view.container);
    await interact(() => modeControl('dark').click());

    // Assert — an explicit mode needs no parenthetical.
    expect(trigger(view.container).getAttribute('aria-label')).toBe('Theme: Studio, Dark');

    // Act
    await interact(() => familyControls()[2]?.click());

    // Assert
    expect(trigger(view.container).getAttribute('aria-label')).toBe('Theme: Neo-Brutalism, Dark');
    await view.unmount();
  });

  it('opens on the family in force and points aria-controls at the live panel', async () => {
    // Arrange
    installMatchMedia();
    const view = await mount(<ThemeToggle store={new ThemePreferenceStore(memoryStorage())} />);

    // Act
    await open(view.container);

    // Assert
    const dialog = panel();
    if (!dialog) throw new Error('the panel did not open');
    expect(trigger(view.container).getAttribute('aria-expanded')).toBe('true');
    expect(trigger(view.container).getAttribute('aria-controls')).toBe(dialog.id);
    expect((document.activeElement as HTMLElement | null)?.dataset.family).toBe('studio');
    // It is a dialog you can see past: the page behind stays live.
    expect(dialog.getAttribute('aria-modal')).toBeNull();

    await view.unmount();
  });

  it('closes on a second trigger press and hands focus back', async () => {
    // Arrange
    installMatchMedia();
    const view = await mount(<ThemeToggle store={new ThemePreferenceStore(memoryStorage())} />);
    await open(view.container);

    // Act
    await interact(() => trigger(view.container).click());

    // Assert
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger(view.container));
    await view.unmount();
  });

  it('answers Escape only while it is the top overlay, and returns focus when it does', async () => {
    // Arrange
    installMatchMedia();
    const view = await mount(<ThemeToggle store={new ThemePreferenceStore(memoryStorage())} />);
    await open(view.container);
    const before = escapeLayerCount();

    // Act — something opened over the popover; that layer owns the gesture.
    const release = pushEscapeLayer({});
    await interact(() => pressKey(document, 'Escape'));

    // Assert
    expect(panel()).not.toBeNull();

    // Act
    release();
    await interact(() => pressKey(document, 'Escape'));

    // Assert
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger(view.container));
    expect(escapeLayerCount()).toBe(before - 1);
    await view.unmount();
  });

  it('ignores a key that is not Escape', async () => {
    // Arrange
    installMatchMedia();
    const view = await mount(<ThemeToggle store={new ThemePreferenceStore(memoryStorage())} />);
    await open(view.container);

    // Act
    await interact(() => pressKey(document, 'k'));

    // Assert
    expect(panel()).not.toBeNull();
    await view.unmount();
  });

  it('dismisses on an outside click without snatching focus back from wherever it went', async () => {
    // Arrange
    installMatchMedia();
    const view = await mount(<ThemeToggle store={new ThemePreferenceStore(memoryStorage())} />);
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    await open(view.container);

    // Act — a click INSIDE the popover is not a dismissal.
    await interact(() => {
      familyCards()[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    // Assert
    expect(panel()).not.toBeNull();

    // Act
    await interact(() => {
      elsewhere.focus();
      elsewhere.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    // Assert
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);

    elsewhere.remove();
    await view.unmount();
  });

  it('leaves an outside click to the layer above when one is open over it', async () => {
    // Arrange
    installMatchMedia();
    const view = await mount(<ThemeToggle store={new ThemePreferenceStore(memoryStorage())} />);
    await open(view.container);
    const release = pushEscapeLayer({});

    // Act — this is the higher layer's scrim, not the page behind.
    await interact(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));

    // Assert
    expect(panel()).not.toBeNull();
    release();
    await view.unmount();
  });

  it('closes when the software keyboard opens under it, because its chrome is about to hide', async () => {
    // Arrange
    installMatchMedia();
    const view = await mount(<ThemeToggle store={new ThemePreferenceStore(memoryStorage())} />);
    await open(view.container);

    // Act
    document.documentElement.setAttribute(KEYBOARD_ATTRIBUTE, 'open');
    await settle(() => panel() === null);

    // Assert — closed, and focus was NOT pushed onto the hiding trigger.
    expect(panel()).toBeNull();
    expect(document.activeElement).not.toBe(trigger(view.container));
    await view.unmount();
  });

  it('cycles Tab inside the panel instead of letting focus leak into the page behind', async () => {
    // Arrange
    installMatchMedia();
    const view = await mount(<ThemeToggle store={new ThemePreferenceStore(memoryStorage())} />);
    await open(view.container);
    const dialog = panel();
    if (!dialog) throw new Error('the panel did not open');

    // Act — forwards from the last tab stop wraps to the first.
    let event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await interact(() => (document.activeElement ?? dialog).dispatchEvent(event));

    // Assert
    expect(event.defaultPrevented).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Act — backwards from the first wraps to the last.
    event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    await interact(() => (document.activeElement ?? dialog).dispatchEvent(event));

    // Assert
    expect(event.defaultPrevented).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Act — a key that is not Tab is none of the cycle's business.
    const other = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    await interact(() => dialog.dispatchEvent(other));

    // Assert
    expect(panel()).not.toBeNull();
    await view.unmount();
  });

  it('does nothing on Tab when the panel holds no tab stop at all', async () => {
    // Arrange
    installMatchMedia();
    const view = await mount(<ThemeToggle store={new ThemePreferenceStore(memoryStorage())} />);
    await open(view.container);
    const dialog = panel();
    if (!dialog) throw new Error('the panel did not open');
    // happy-dom reports every element as unrendered, so the only stop is the
    // focused one; blurring leaves the panel with none.
    (document.activeElement as HTMLElement | null)?.blur();

    // Act
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await interact(() => dialog.dispatchEvent(event));

    // Assert
    expect(event.defaultPrevented).toBe(false);
    await view.unmount();
  });
});
