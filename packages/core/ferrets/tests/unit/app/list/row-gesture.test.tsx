import { afterEach, describe, expect, it } from 'bun:test';
import { useState } from 'react';
import {
  cancelsRowLongPress,
  LONG_PRESS_MS,
  opensContextMenuKey,
  type RowOpenedBy,
  suppressesRowClick,
  useRowContextGesture,
} from '../../../../app/features/list/row-context-gesture.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

interface Opened {
  readonly subject: string;
  readonly x: number;
  readonly y: number;
  readonly by: RowOpenedBy;
  readonly trigger: HTMLElement;
}

function Row({ opened, offered }: { readonly opened: Opened[]; readonly offered: boolean }) {
  const [pressing, setPressing] = useState(false);
  const gesture = useRowContextGesture<string>(
    offered ? (subject, x, y, by, trigger) => opened.push({ subject, x, y, by, trigger }) : undefined,
    'lead',
    setPressing,
  );
  return (
    <a data-row="" data-pressing={pressing ? '' : undefined} href="#lead" tabIndex={0} {...gesture}>
      lead
    </a>
  );
}

const mountRow = async (offered = true): Promise<{ opened: Opened[]; row: HTMLElement }> => {
  const opened: Opened[] = [];
  mounted = await mount(<Row offered={offered} opened={opened} />);
  return { opened, row: must(mounted.container.querySelector<HTMLElement>('[data-row]'), 'the row') };
};

const fire = (target: EventTarget, type: string, fields: Record<string, unknown> = {}): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, clientX: 0, clientY: 0, button: 2, ...fields });
  target.dispatchEvent(event);
  return event;
};
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('the row context gesture, as pure rules', () => {
  it('the Menu key and Shift+F10 open it; F10 alone and any other key do not', () => {
    expect(opensContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
    expect(opensContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(opensContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
    expect(opensContextMenuKey({ key: 'a', shiftKey: true })).toBe(false);
  });

  it('a drift of more than ten pixels either way is a scroll, not a dwell', () => {
    const start = { x: 100, y: 100 };
    expect(cancelsRowLongPress(start, { x: 110, y: 100 })).toBe(false);
    expect(cancelsRowLongPress(start, { x: 111, y: 100 })).toBe(true);
    expect(cancelsRowLongPress(start, { x: 100, y: 89 })).toBe(true);
    expect(cancelsRowLongPress(start, { x: 95, y: 105 })).toBe(false);
  });

  it('the click after a menu-opening press is swallowed for 700ms, and never when no menu opened', () => {
    expect(suppressesRowClick(0, 100)).toBe(false);
    expect(suppressesRowClick(1_000, 1_699)).toBe(true);
    expect(suppressesRowClick(1_000, 1_700)).toBe(false);
  });
});

describe('the row context gesture', () => {
  it('a right-click opens at the pointer for that subject, and the browser’s own menu stays away', async () => {
    const { opened, row } = await mountRow();
    await interact(() => {
      expect(fire(row, 'contextmenu', { clientX: 140, clientY: 210 }).defaultPrevented).toBe(true);
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ subject: 'lead', x: 140, y: 210, by: 'mouse', trigger: row });
  });

  it('the Menu key and Shift+F10 open it at the row’s foot; other keys do nothing', async () => {
    const { opened, row } = await mountRow();
    await interact(() => {
      expect(fire(row, 'keydown', { key: 'a' }).defaultPrevented).toBe(false);
      expect(fire(row, 'keydown', { key: 'F10', shiftKey: false }).defaultPrevented).toBe(false);
    });
    expect(opened).toHaveLength(0);
    await interact(() => {
      expect(fire(row, 'keydown', { key: 'ContextMenu', shiftKey: false }).defaultPrevented).toBe(true);
      fire(row, 'keydown', { key: 'F10', shiftKey: true });
    });
    expect(opened.map(entry => entry.by)).toEqual(['keyboard', 'keyboard']);
    expect(opened[0]?.trigger).toBe(row);
  });

  it('a mouse press starts no dwell timer', async () => {
    const { opened, row } = await mountRow();
    await interact(() => fire(row, 'pointerdown', { pointerType: 'mouse', button: 0 }));
    expect(row.hasAttribute('data-pressing')).toBe(false);
    await interact(() => sleep(LONG_PRESS_MS + 60));
    expect(opened).toHaveLength(0);
  });

  it('a held finger shows the hold on the row, then opens the sheet where the finger is', async () => {
    const { opened, row } = await mountRow();
    await interact(() => fire(row, 'pointerdown', { pointerType: 'touch', clientX: 20, clientY: 30 }));
    expect(row.hasAttribute('data-pressing')).toBe(true);
    await interact(() => sleep(LONG_PRESS_MS + 60));
    expect(row.hasAttribute('data-pressing')).toBe(false);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ x: 20, y: 30, by: 'touch' });
  });

  it('a finger that drifts, lifts or is taken by the browser before the dwell opens nothing', async () => {
    const { opened, row } = await mountRow();
    await interact(() => {
      fire(row, 'pointermove', { pointerType: 'touch', clientX: 500, clientY: 500 });
      fire(row, 'pointerdown', { pointerType: 'touch', clientX: 20, clientY: 30 });
      fire(row, 'pointermove', { pointerType: 'touch', clientX: 24, clientY: 33 });
    });
    expect(row.hasAttribute('data-pressing')).toBe(true);
    await interact(() => fire(row, 'pointermove', { pointerType: 'touch', clientX: 20, clientY: 80 }));
    expect(row.hasAttribute('data-pressing')).toBe(false);

    await interact(() => fire(row, 'pointerdown', { pointerType: 'touch', clientX: 20, clientY: 30 }));
    await interact(() => fire(row, 'pointerup', { pointerType: 'touch' }));
    expect(row.hasAttribute('data-pressing')).toBe(false);

    await interact(() => fire(row, 'pointerdown', { pointerType: 'pen', clientX: 20, clientY: 30 }));
    await interact(() => fire(row, 'pointercancel', { pointerType: 'pen' }));
    expect(row.hasAttribute('data-pressing')).toBe(false);

    await interact(() => sleep(LONG_PRESS_MS + 60));
    expect(opened).toHaveLength(0);
  });

  it('a second press clears the first’s timer, so one dwell opens one menu', async () => {
    const { opened, row } = await mountRow();
    await interact(() => fire(row, 'pointerdown', { pointerType: 'touch', clientX: 1, clientY: 1 }));
    await interact(() => fire(row, 'pointerdown', { pointerType: 'touch', clientX: 2, clientY: 2 }));
    await interact(() => sleep(LONG_PRESS_MS + 60));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ x: 2, y: 2 });
  });

  it('a right-click that follows a press cancels its dwell', async () => {
    const { opened, row } = await mountRow();
    await interact(() => fire(row, 'pointerdown', { pointerType: 'touch', clientX: 1, clientY: 1 }));
    await interact(() => fire(row, 'contextmenu', { clientX: 7, clientY: 8 }));
    await interact(() => sleep(LONG_PRESS_MS + 60));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ x: 7, y: 8, by: 'mouse' });
  });

  it('swallows the click the opening press produces, once, so it cannot open the ferret under the menu', async () => {
    const { row } = await mountRow();
    await interact(() => fire(row, 'contextmenu'));
    let clicks = 0;
    row.addEventListener('click', () => {
      clicks += 1;
    });
    let first: Event | undefined;
    await interact(() => {
      first = fire(row, 'click', { button: 0 });
    });
    expect(first?.defaultPrevented).toBe(true);
    expect(clicks).toBe(0);
    let second: Event | undefined;
    await interact(() => {
      second = fire(row, 'click', { button: 0 });
    });
    expect(second?.defaultPrevented).toBe(false);
    expect(clicks).toBe(1);
  });

  it('lets an ordinary click through when no menu was just opened', async () => {
    const { row } = await mountRow();
    let click: Event | undefined;
    await interact(() => {
      click = fire(row, 'click', { button: 0 });
    });
    expect(click?.defaultPrevented).toBe(false);
  });

  it('offers nothing, and leaves the browser’s own context menu alone, when the host draws no menu', async () => {
    const { opened, row } = await mountRow(false);
    await interact(() => {
      expect(fire(row, 'contextmenu').defaultPrevented).toBe(false);
      fire(row, 'keydown', { key: 'ContextMenu' });
    });
    expect(opened).toHaveLength(0);
  });

  it('a row that leaves the page with a dwell under way never opens a menu', async () => {
    const { opened, row } = await mountRow();
    await interact(() => fire(row, 'pointerdown', { pointerType: 'touch', clientX: 1, clientY: 1 }));
    await mounted?.render(<div />);
    await interact(() => sleep(LONG_PRESS_MS + 60));
    expect(opened).toHaveLength(0);
  });
});
