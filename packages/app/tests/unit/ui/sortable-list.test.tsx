import { afterEach, describe, expect, test } from 'bun:test';
import { interact, type Mounted, mount, must, pressKey } from '../../../src/testing/index.ts';
import { SortableList } from '../../../src/ui/sortable-list.tsx';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const ROW = 50;
const NAMES = ['Ferrets', 'Agenda', 'Board', 'Insights'] as const;

/** happy-dom has no layout: every row is ROW tall and stacked in DOM order, so a drag has something to measure. */
const layOut = (container: HTMLElement): void => {
  for (const row of container.querySelectorAll<HTMLElement>('li')) {
    Object.defineProperty(row, 'offsetTop', {
      configurable: true,
      get: () => Array.from(row.parentElement?.children ?? []).indexOf(row) * ROW,
    });
    Object.defineProperty(row, 'offsetHeight', { configurable: true, value: ROW });
  }
};

interface Harness {
  readonly changes: (readonly string[])[];
}

const show = async (names: readonly string[] = NAMES, disabled = false): Promise<Harness> => {
  const changes: (readonly string[])[] = [];
  view = await mount(
    <SortableList
      disabled={disabled}
      itemKey={name => name}
      itemLabel={name => name}
      items={names}
      label="Navigation items"
      onReorder={next => changes.push(next)}
      renderItem={name => <span data-testid="content">{name}</span>}
    />,
  );
  layOut(view.container);
  return { changes };
};

const order = (): string[] =>
  Array.from(must(view, 'the view').container.querySelectorAll('li')).map(
    row => row.getAttribute('data-sortable-key') ?? '',
  );
const grip = (name: string): HTMLButtonElement =>
  must(view?.container.querySelector<HTMLButtonElement>(`button[aria-label="Reorder ${name}"]`), `the grip of ${name}`);
const button = (label: string): HTMLButtonElement =>
  must(view?.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`), label);
const status = (): string => view?.container.querySelector('[role="status"]')?.textContent ?? '';
/** A pointer event as the browser dispatches it: React reads `pointerId` and `pointerType` off it. */
const pointerEvent = (type: string, clientY: number): Event => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
  return event;
};
const fire = (target: Element, type: string, clientY: number): Promise<void> =>
  interact(() => target.dispatchEvent(pointerEvent(type, clientY)));

describe('SortableList rendering', () => {
  test('draws every item with a grip, up and down buttons, and its own content', async () => {
    await show();
    expect(order()).toEqual([...NAMES]);
    expect(must(view, 'view').container.querySelectorAll('[data-testid="content"]').length).toBe(4);
    expect(button('Move Agenda up').getAttribute('aria-disabled')).toBeNull();
    expect(button('Move Ferrets up').getAttribute('aria-disabled')).toBe('true');
    expect(button('Move Insights down').getAttribute('aria-disabled')).toBe('true');
    expect(must(view, 'view').container.querySelector('ul')?.getAttribute('aria-label')).toBe('Navigation items');
    expect(must(view, 'view').container.querySelector('input')).toBeNull();
  });
});

describe('SortableList buttons', () => {
  test('Down and Up report the new order at once and announce it', async () => {
    const { changes } = await show();
    await interact(() => button('Move Ferrets down').click());
    expect(changes).toEqual([['Agenda', 'Ferrets', 'Board', 'Insights']]);
    expect(status()).toBe('Ferrets moved to position 2 of 4.');
    await interact(() => button('Move Insights up').click());
    expect(changes[1]).toEqual(['Ferrets', 'Agenda', 'Insights', 'Board']);
  });

  test('an end button does nothing', async () => {
    const { changes } = await show();
    await interact(() => button('Move Ferrets up').click());
    await interact(() => button('Move Insights down').click());
    expect(changes).toEqual([]);
  });

  test('a disabled list reports nothing', async () => {
    const { changes } = await show(NAMES, true);
    await interact(() => button('Move Agenda down').click());
    expect(changes).toEqual([]);
  });
});

describe('SortableList keyboard', () => {
  test('Space lifts, arrows move the draft, Enter drops and reports once', async () => {
    const { changes } = await show();
    const handle = grip('Agenda');
    await interact(() => pressKey(handle, ' '));
    expect(status()).toContain('Agenda lifted, position 2 of 4');
    expect(handle.getAttribute('aria-pressed')).toBe('true');
    await interact(() => pressKey(handle, 'ArrowDown'));
    await interact(() => pressKey(handle, 'ArrowDown'));
    expect(order()).toEqual(['Ferrets', 'Board', 'Insights', 'Agenda']);
    expect(changes).toEqual([]);
    expect(status()).toBe('Agenda moved to position 4 of 4.');
    await interact(() => pressKey(handle, 'ArrowDown'));
    await interact(() => pressKey(handle, 'Enter'));
    expect(changes).toEqual([['Ferrets', 'Board', 'Insights', 'Agenda']]);
    expect(status()).toBe('Agenda dropped at position 4 of 4.');
  });

  test('Escape puts the row back and reports nothing', async () => {
    const { changes } = await show();
    const handle = grip('Board');
    await interact(() => pressKey(handle, 'Enter'));
    await interact(() => pressKey(handle, 'ArrowUp'));
    expect(order()[1]).toBe('Board');
    await interact(() => pressKey(document, 'Escape'));
    expect(order()).toEqual([...NAMES]);
    expect(changes).toEqual([]);
    expect(status()).toBe('Reorder cancelled. Board is back at position 3 of 4.');
  });

  test('leaving the grip cancels a lifted row', async () => {
    const { changes } = await show();
    const handle = grip('Board');
    await interact(() => pressKey(handle, ' '));
    await interact(() => pressKey(handle, 'ArrowUp'));
    await interact(() => handle.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(order()).toEqual([...NAMES]);
    expect(changes).toEqual([]);
  });

  test('dropping where it started reports nothing', async () => {
    const { changes } = await show();
    const handle = grip('Board');
    await interact(() => pressKey(handle, ' '));
    await interact(() => pressKey(handle, ' '));
    expect(changes).toEqual([]);
  });

  test('other keys are ignored', async () => {
    const { changes } = await show();
    const handle = grip('Board');
    await interact(() => pressKey(handle, 'ArrowDown'));
    await interact(() => pressKey(handle, 'a'));
    expect(order()).toEqual([...NAMES]);
    expect(changes).toEqual([]);
  });
});

describe('SortableList pointer', () => {
  test('a drag past the next rows moves the draft live and reports once on release', async () => {
    const { changes } = await show();
    const handle = grip('Ferrets');
    await fire(handle, 'pointerdown', 25);
    expect(must(view, 'view').container.querySelector('li')?.getAttribute('data-state')).toBe('held');
    await fire(handle, 'pointermove', 130);
    expect(order()).toEqual(['Agenda', 'Board', 'Ferrets', 'Insights']);
    expect(changes).toEqual([]);
    await fire(handle, 'pointerup', 130);
    expect(changes).toEqual([['Agenda', 'Board', 'Ferrets', 'Insights']]);
    expect(status()).toBe('Ferrets dropped at position 3 of 4.');
  });

  test('dragging up works too, and the row follows the pointer', async () => {
    const { changes } = await show();
    const handle = grip('Insights');
    await fire(handle, 'pointerdown', 175);
    await fire(handle, 'pointermove', 60);
    const held = must(view?.container.querySelector<HTMLElement>('[data-state="held"]'), 'the held row');
    expect(held.style.transform).toContain('translateY(');
    await fire(handle, 'pointerup', 60);
    expect(changes[0]?.indexOf('Insights')).toBe(1);
  });

  test('a cancelled pointer puts everything back', async () => {
    const { changes } = await show();
    const handle = grip('Ferrets');
    await fire(handle, 'pointerdown', 25);
    await fire(handle, 'pointermove', 160);
    await fire(handle, 'pointercancel', 160);
    expect(order()).toEqual([...NAMES]);
    expect(changes).toEqual([]);
  });

  test('Escape during a drag cancels it', async () => {
    const { changes } = await show();
    const handle = grip('Ferrets');
    await fire(handle, 'pointerdown', 25);
    await fire(handle, 'pointermove', 160);
    await interact(() => pressKey(document, 'Escape'));
    expect(order()).toEqual([...NAMES]);
    expect(changes).toEqual([]);
  });

  test('a press and release without moving reports nothing', async () => {
    const { changes } = await show();
    const handle = grip('Board');
    await fire(handle, 'pointerdown', 125);
    await fire(handle, 'pointerup', 125);
    expect(changes).toEqual([]);
  });

  test('a disabled list cannot be picked up', async () => {
    const { changes } = await show(NAMES, true);
    const handle = grip('Ferrets');
    await fire(handle, 'pointerdown', 25);
    await fire(handle, 'pointermove', 160);
    await fire(handle, 'pointerup', 160);
    expect(order()).toEqual([...NAMES]);
    expect(changes).toEqual([]);
  });
});
