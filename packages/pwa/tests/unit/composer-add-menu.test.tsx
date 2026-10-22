import { describe, expect, test } from 'bun:test';
import { createRef } from 'react';
import {
  type AddMenuAction,
  addMenuActions,
  ComposerAddMenu,
  popoverPlacement,
} from '../../src/components/composer-add-menu.tsx';
import { interact, mount, must, pressKey } from '../support/dom.ts';

describe('addMenuActions', () => {
  test('always offers attach, and adds camera and location only where they work', () => {
    const noop = () => {};
    expect(addMenuActions({ attach: noop }).map(a => a.key)).toEqual(['attach']);
    expect(addMenuActions({ attach: noop, camera: noop, location: noop }).map(a => a.key)).toEqual([
      'attach',
      'camera',
      'location',
    ]);
  });

  test('every row says what it is and what it takes', () => {
    const rows = addMenuActions({ attach: () => {}, camera: () => {}, location: () => {} });
    expect(rows.map(a => [a.label, a.hint])).toEqual([
      ['Attach files', 'Photos, screenshots, documents'],
      ['Take photo', 'Use the camera'],
      ['Share location', 'Send where you are, with a map'],
    ]);
  });
});

describe('popoverPlacement', () => {
  const viewport = { width: 1440, height: 900 };

  test('sits above the composer, aligned to the plus', () => {
    expect(popoverPlacement({ left: 300 }, 800, viewport)).toEqual({ left: 300, bottom: 108 });
  });

  test('stays inside the viewport on both sides', () => {
    expect(popoverPlacement({ left: -40 }, 800, viewport).left).toBe(8);
    expect(popoverPlacement({ left: 1400 }, 800, viewport).left).toBe(1440 - 304 - 8);
  });

  test('keeps a margin when the composer is at the very top', () => {
    expect(popoverPlacement({ left: 10 }, 0, { width: 400, height: 300 }).bottom).toBe(308);
    expect(popoverPlacement({ left: 10 }, 900, { width: 400, height: 300 }).bottom).toBe(8);
  });
});

const setup = async (variant: 'sheet' | 'popover', open = true) => {
  const calls: string[] = [];
  let closed = 0;
  const actions: readonly AddMenuAction[] = addMenuActions({
    attach: () => calls.push('attach'),
    camera: () => calls.push('camera'),
    location: () => calls.push('location'),
  });
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const anchorRef = createRef<HTMLElement>();
  (anchorRef as { current: HTMLElement | null }).current = anchor;
  const view = await mount(
    <ComposerAddMenu
      actions={actions}
      anchorRef={anchorRef}
      onClose={() => {
        closed += 1;
      }}
      open={open}
      variant={variant}
    />,
  );
  return { view, calls, closed: () => closed, anchor };
};

const items = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];

describe('ComposerAddMenu', () => {
  test('renders nothing while closed', async () => {
    const { view } = await setup('sheet', false);
    expect(document.querySelector('[data-testid="composer-add-menu"]')).toBeNull();
    await view.unmount();
  });

  test('a sheet shows labelled rows with hints, a heading and Cancel, and focuses the first row', async () => {
    const { view } = await setup('sheet');
    const dialog = must(document.querySelector('[data-testid="composer-add-menu"]'), 'the menu');
    expect(dialog.getAttribute('data-variant')).toBe('sheet');
    expect(dialog.getAttribute('aria-label')).toBe('Add to message');
    expect(items().map(row => row.textContent)).toEqual([
      'Attach filesPhotos, screenshots, documents',
      'Take photoUse the camera',
      'Share locationSend where you are, with a map',
    ]);
    expect(document.activeElement).toBe(items()[0] as HTMLElement);
    expect(dialog.textContent).toContain('Cancel');
    await view.unmount();
  });

  test('rows are at least 44px touch targets in both shapes', async () => {
    for (const variant of ['sheet', 'popover'] as const) {
      const { view } = await setup(variant);
      for (const row of items()) expect(row.className).toMatch(/min-h-\[(48|56)px\]/u);
      await view.unmount();
    }
  });

  test('a popover has no Cancel button and no heading', async () => {
    const { view } = await setup('popover');
    const dialog = must(document.querySelector('[data-testid="composer-add-menu"]'), 'the menu');
    expect(dialog.getAttribute('data-variant')).toBe('popover');
    expect(dialog.textContent).not.toContain('Cancel');
    await view.unmount();
  });

  test('choosing a row runs it once and closes the menu', async () => {
    const { view, calls, closed } = await setup('sheet');
    await interact(() => items()[2]?.click());
    expect(calls).toEqual(['location']);
    expect(closed()).toBe(1);
    await view.unmount();
  });

  test('Cancel closes without running anything', async () => {
    const { view, calls, closed } = await setup('sheet');
    const cancel = must(
      [...document.querySelectorAll('button')].find(button => button.textContent === 'Cancel'),
      'Cancel',
    );
    await interact(() => cancel.click());
    expect(calls).toEqual([]);
    expect(closed()).toBe(1);
    await view.unmount();
  });

  test('a tap on the scrim (the dialog itself) closes; a tap inside the panel does not', async () => {
    const { view, closed } = await setup('sheet');
    const dialog = must(document.querySelector<HTMLElement>('[data-testid="composer-add-menu"]'), 'the menu');
    await interact(() => must(dialog.querySelector<HTMLElement>('[role="menu"]'), 'menu').click());
    expect(closed()).toBe(0);
    await interact(() => dialog.click());
    expect(closed()).toBe(1);
    await view.unmount();
  });

  test('Escape closes', async () => {
    const { view, closed } = await setup('popover');
    await interact(() => pressKey(items()[0] as HTMLElement, 'Escape'));
    expect(closed()).toBeGreaterThanOrEqual(1);
    await view.unmount();
  });

  test('arrows, Home and End rove focus and wrap', async () => {
    const { view } = await setup('popover');
    const rows = items();
    await interact(() => pressKey(rows[0] as HTMLElement, 'ArrowDown'));
    expect(document.activeElement).toBe(rows[1] as HTMLElement);
    await interact(() => pressKey(rows[1] as HTMLElement, 'End'));
    expect(document.activeElement).toBe(rows[2] as HTMLElement);
    await interact(() => pressKey(rows[2] as HTMLElement, 'ArrowDown'));
    expect(document.activeElement).toBe(rows[0] as HTMLElement);
    await interact(() => pressKey(rows[0] as HTMLElement, 'ArrowUp'));
    expect(document.activeElement).toBe(rows[2] as HTMLElement);
    await interact(() => pressKey(rows[2] as HTMLElement, 'Home'));
    expect(document.activeElement).toBe(rows[0] as HTMLElement);
    await view.unmount();
  });

  test('a resize or a scroll never dismisses it, and the same menu stays mounted', async () => {
    for (const variant of ['sheet', 'popover'] as const) {
      const { view, closed } = await setup(variant);
      const before = document.querySelector('[data-testid="composer-add-menu"]');
      await interact(() => {
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('scroll'));
        document.dispatchEvent(new Event('scroll'));
      });
      expect(closed()).toBe(0);
      expect(document.querySelector('[data-testid="composer-add-menu"]')).toBe(before);
      await view.unmount();
    }
  });

  test('history navigation (the Android back gesture) closes it', async () => {
    const { view, closed } = await setup('sheet');
    await interact(() => window.dispatchEvent(new Event('popstate')));
    expect(closed()).toBe(1);
    await view.unmount();
  });
});
