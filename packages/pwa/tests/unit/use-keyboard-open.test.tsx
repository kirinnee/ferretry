import { afterEach, describe, expect, it } from 'bun:test';
import { KEYBOARD_ATTRIBUTE, keyboardOpenFromAttribute, useKeyboardOpen } from '../../src/hooks/use-keyboard-open.ts';
import { interact, mount } from '../support/dom.ts';

const Probe = () => <span data-open={String(useKeyboardOpen())} />;

const openOf = (container: HTMLElement): string | null =>
  container.querySelector('span')?.getAttribute('data-open') ?? null;

const observeMutations = () => {
  let observer:
    | {
        disconnected: boolean;
        fire: () => void;
      }
    | undefined;
  const globals = globalThis as typeof globalThis & { MutationObserver: typeof MutationObserver };
  const original = globals.MutationObserver;
  class ProbeObserver {
    disconnected = false;
    #callback: MutationCallback;
    constructor(callback: MutationCallback) {
      this.#callback = callback;
      observer = this;
    }
    observe(): void {}
    disconnect(): void {
      this.disconnected = true;
    }
    fire(): void {
      this.#callback([], this as unknown as MutationObserver);
    }
  }
  globals.MutationObserver = ProbeObserver as unknown as typeof MutationObserver;
  return {
    observer: () => {
      if (observer === undefined) throw new Error('expected useKeyboardOpen to create an observer');
      return observer;
    },
    restore: () => {
      globals.MutationObserver = original;
    },
  };
};

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
    const mutations = observeMutations();
    try {
      const view = await mount(<Probe />);

      // Act
      document.documentElement.setAttribute(KEYBOARD_ATTRIBUTE, 'open');
      await interact(() => mutations.observer().fire());

      // Assert
      expect(openOf(view.container)).toBe('true');

      // Act
      document.documentElement.setAttribute(KEYBOARD_ATTRIBUTE, 'closed');
      await interact(() => mutations.observer().fire());

      // Assert
      expect(openOf(view.container)).toBe('false');
      await view.unmount();
    } finally {
      mutations.restore();
    }
  });

  it('detaches its observer with the component, so an unmounted probe never updates', async () => {
    // Arrange
    const mutations = observeMutations();

    try {
      const view = await mount(<Probe />);

      // Act
      await view.unmount();

      // Assert — a disconnected observer cannot schedule a state update after unmount.
      expect(mutations.observer().disconnected).toBe(true);
    } finally {
      mutations.restore();
    }
  });
});
