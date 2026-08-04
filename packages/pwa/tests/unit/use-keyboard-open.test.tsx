import { afterEach, describe, expect, it } from 'bun:test';
import { KEYBOARD_ATTRIBUTE, keyboardOpenFromAttribute, useKeyboardOpen } from '../../src/hooks/use-keyboard-open.ts';
import { interact, mount } from '../support/dom.ts';

const Probe = () => <span data-open={String(useKeyboardOpen())} />;

const openOf = (container: HTMLElement): string | null =>
  container.querySelector('span')?.getAttribute('data-open') ?? null;

afterEach(() => {
  document.documentElement.removeAttribute(KEYBOARD_ATTRIBUTE);
});

describe('keyboardOpenFromAttribute', () => {
  it('counts only the literal `open`, so a stale or partial value never hides chrome', () => {
    expect(keyboardOpenFromAttribute('open')).toBe(true);
    expect(keyboardOpenFromAttribute('closed')).toBe(false);
    expect(keyboardOpenFromAttribute('')).toBe(false);
    expect(keyboardOpenFromAttribute(null)).toBe(false);
  });
});

describe('useKeyboardOpen', () => {
  it('reports closed on a viewport whose producer has never written the attribute', async () => {
    // Act
    const view = await mount(<Probe />);

    // Assert — the not-yet-ported useAppViewport degrades to desktop behaviour.
    expect(openOf(view.container)).toBe('false');
    await view.unmount();
  });

  it('reads an attribute that was already set before the component mounted', async () => {
    // Arrange
    document.documentElement.setAttribute(KEYBOARD_ATTRIBUTE, 'open');

    // Act
    const view = await mount(<Probe />);

    // Assert
    expect(openOf(view.container)).toBe('true');
    await view.unmount();
  });

  it('follows the attribute in both directions while mounted', async () => {
    // Arrange
    const view = await mount(<Probe />);

    // Act
    await interact(() => document.documentElement.setAttribute(KEYBOARD_ATTRIBUTE, 'open'));

    // Assert
    expect(openOf(view.container)).toBe('true');

    // Act
    await interact(() => document.documentElement.setAttribute(KEYBOARD_ATTRIBUTE, 'closed'));

    // Assert
    expect(openOf(view.container)).toBe('false');
    await view.unmount();
  });

  it('detaches its observer with the component, so an unmounted probe never updates', async () => {
    // Arrange
    let observer: { disconnected: boolean } | undefined;
    const globals = globalThis as typeof globalThis & { MutationObserver: typeof MutationObserver };
    const original = globals.MutationObserver;
    class ProbeObserver {
      disconnected = false;
      constructor(_callback: MutationCallback) {
        observer = this;
      }
      observe(): void {}
      disconnect(): void {
        this.disconnected = true;
      }
    }
    globals.MutationObserver = ProbeObserver as unknown as typeof MutationObserver;

    try {
      const view = await mount(<Probe />);

      // Act
      await view.unmount();

      // Assert — a disconnected observer cannot schedule a state update after unmount.
      expect(observer?.disconnected).toBe(true);
    } finally {
      globals.MutationObserver = original;
    }
  });
});
