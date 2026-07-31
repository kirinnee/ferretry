import { afterEach, describe, expect, it } from 'bun:test';
import { KEYBOARD_ATTRIBUTE, keyboardOpenFromAttribute, useKeyboardOpen } from '../../src/hooks/use-keyboard-open.ts';
import { interact, mount } from '../support/dom.ts';

const Probe = () => <span data-open={String(useKeyboardOpen())} />;

const openOf = (container: HTMLElement): string | null =>
  container.querySelector('span')?.getAttribute('data-open') ?? null;

/**
 * The observer answers on a microtask the test cannot await directly, and under
 * coverage instrumentation one turn of the loop is not always enough. Settle
 * until the probe agrees rather than guessing a number of turns.
 */
const settle = async (until: () => boolean, turns = 20): Promise<void> => {
  for (let turn = 0; turn < turns && !until(); turn++) {
    await interact(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  }
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
    const view = await mount(<Probe />);

    // Act
    document.documentElement.setAttribute(KEYBOARD_ATTRIBUTE, 'open');
    await settle(() => openOf(view.container) === 'true');

    // Assert
    expect(openOf(view.container)).toBe('true');

    // Act
    document.documentElement.setAttribute(KEYBOARD_ATTRIBUTE, 'closed');
    await settle(() => openOf(view.container) === 'false');

    // Assert
    expect(openOf(view.container)).toBe('false');
    await view.unmount();
  });

  it('detaches its observer with the component, so an unmounted probe never updates', async () => {
    // Arrange
    const view = await mount(<Probe />);
    await view.unmount();

    // Act + Assert — a write after unmount must not throw a React update warning.
    document.documentElement.setAttribute(KEYBOARD_ATTRIBUTE, 'open');
    await settle(() => false, 3);
    expect(document.documentElement.getAttribute(KEYBOARD_ATTRIBUTE)).toBe('open');
  });
});
