import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { drawerState } from '../../../src/shell/drawer-state.ts';
import { APP_STORAGE } from '../../../src/storage/names.ts';
import { interact, type Mounted, must, pressKey } from '../../support/dom.ts';
import { bootApp, settle } from './frame-fixtures.tsx';

/**
 * THE LEFT DRAWER (r8-SHELL): no row of places across the top; Find is the drawer's first control and Cmd/Ctrl+K lands on it;
 * the drawer collapses to a rail and remembers that on this device; the machine item is drawn only with two machines.
 */

/** What the drawer's Tab trap counts as a stop (the same list the dialog hook uses, in the parts a drawer holds). */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

let view: Mounted | undefined;
beforeEach(() => {
  // The state is one shared object: start every test with nothing chosen.
  drawerState.forget();
});
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  drawerState.forget();
});

const find = (root: ParentNode): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>('[data-drawer-find]'), 'Find');
const toggle = (root: ParentNode): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>('[data-drawer-toggle]'), 'the drawer toggle');

describe('the left drawer', () => {
  test('there is no top row: no nav bar and no top bar, and the drawer holds Find then the places', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1' });
    view = app.view;
    const root = app.view.container;
    expect(root.querySelector('.fy-top, .fy-nav--top, header[data-slot="top"]')).toBeNull();
    const drawer = must(root.querySelector('.fy-drawer'), 'the drawer');
    expect(drawer.parentElement?.classList.contains('fy-frame')).toBe(true);
    // Find comes before the places, inside the drawer.
    const order = [...drawer.querySelectorAll('[data-drawer-find], nav[data-slot="nav"]')].map(node =>
      node.matches('[data-drawer-find]') ? 'find' : 'places',
    );
    expect(order).toEqual(['find', 'places']);
    // The page column starts at the top of the body: nothing sits above the status strip and columns.
    expect(root.querySelector('.fy-body')?.firstElementChild?.classList.contains('fy-status')).toBe(true);
  });

  test('Ctrl-K focuses Find and opens the existing command bar; closing it returns the caret to Find', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1' });
    view = app.view;
    const field = find(app.view.container);
    expect(document.activeElement).not.toBe(field);
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));
    await settle();
    expect(document.querySelector('[role="dialog"][aria-label="Command bar"]')).not.toBeNull();
    await interact(() =>
      pressKey(must(document.querySelector<HTMLElement>('[role="combobox"]'), 'the query'), 'Escape'),
    );
    await settle();
    expect(document.querySelector('[role="dialog"][aria-label="Command bar"]')).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  test('pressing Find opens the same command bar', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1' });
    view = app.view;
    await interact(() => find(app.view.container).click());
    await settle();
    expect(document.querySelector('[role="dialog"][aria-label="Command bar"]')).not.toBeNull();
  });

  test('collapsing makes a slim rail (destinations and the find icon), and the choice is remembered on this device', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1' });
    view = app.view;
    const root = app.view.container;
    expect(root.querySelector('.fy-drawer--rail')).toBeNull();
    expect(toggle(root).getAttribute('aria-expanded')).toBe('true');
    await interact(() => toggle(root).click());
    expect(root.querySelector('.fy-drawer--rail')).not.toBeNull();
    expect(root.querySelector('.fy-nav--rail')).not.toBeNull();
    expect(find(root).textContent).toBe('');
    expect(window.localStorage.getItem(APP_STORAGE.drawer)).toContain('"collapsed":true');
    // A fresh app on the same device opens collapsed.
    await app.view.unmount();
    const again = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1' });
    view = again.view;
    expect(again.view.container.querySelector('.fy-drawer--rail')).not.toBeNull();
    await interact(() => toggle(again.view.container).click());
    expect(again.view.container.querySelector('.fy-drawer--rail')).toBeNull();
    expect(window.localStorage.getItem(APP_STORAGE.drawer)).toContain('"collapsed":false');
  });

  test('Ctrl-B toggles the drawer, except while typing in a field', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1' });
    view = app.view;
    const root = app.view.container;
    await interact(() => pressKey(document.body, 'b', { ctrlKey: true }));
    expect(root.querySelector('.fy-drawer--rail')).not.toBeNull();
    const input = document.createElement('input');
    document.body.append(input);
    await interact(() => pressKey(input, 'b', { ctrlKey: true }));
    input.remove();
    expect(root.querySelector('.fy-drawer--rail')).not.toBeNull();
  });

  test('a storage that throws costs only the memory: the drawer still toggles', async () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('storage is refused');
      },
    });
    try {
      const app = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1' });
      view = app.view;
      // The visit's memory (kept by the one shared state) is what is left of the choice; it flips either way.
      const before = app.view.container.querySelector('.fy-drawer--rail') !== null;
      await interact(() => toggle(app.view.container).click());
      expect(app.view.container.querySelector('.fy-drawer--rail') !== null).toBe(!before);
    } finally {
      if (real !== undefined) Object.defineProperty(window, 'localStorage', real);
    }
  });

  test('the machine switcher is not drawn with one machine paired, and is the first item of the drawer with two', async () => {
    const one = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1' });
    view = one.view;
    expect(one.view.container.querySelector('[data-daemon-picker]')).toBeNull();
    await one.view.unmount();
    const two = await bootApp({ surfaces: [], machines: ['d1', 'd2'], path: '/d/d1' });
    view = two.view;
    const first = two.view.container.querySelector('.fy-drawer')?.firstElementChild;
    expect(first?.classList.contains('fy-drawer__machine')).toBe(true);
    expect(first?.querySelector('[data-daemon-picker]')).not.toBeNull();
  });

  test('on a phone the drawer is shut until the menu button opens it, in the same order, and a place chosen shuts it', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1', 'd2'], path: '/d/d1/settings', viewport: 'phone' });
    view = app.view;
    const root = app.view.container;
    expect(root.querySelector('.fy-drawer')).toBeNull();
    await interact(() => must(root.querySelector<HTMLElement>('button[aria-label="Menu"]'), 'the menu button').click());
    const drawer = must(root.querySelector('.fy-drawer--overlay'), 'the overlay');
    expect(drawer.getAttribute('role')).toBe('dialog');
    const order = [...drawer.querySelectorAll('.fy-drawer__machine, [data-drawer-find], nav[data-slot="nav"]')].map(
      node => node.className.split(' ')[0],
    );
    expect(order).toEqual(['fy-drawer__machine', 'fy-search', 'fy-nav']);
    await interact(() => pressKey(drawer, 'Escape'));
    expect(root.querySelector('.fy-drawer')).toBeNull();
  });

  test('on a phone the keyboard goes into the drawer, Tab stays inside it, and Escape shuts it with focus back on Menu', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1/settings', viewport: 'phone' });
    view = app.view;
    const root = app.view.container;
    const menu = must(root.querySelector<HTMLElement>('button[aria-label="Menu"]'), 'the menu button');
    menu.focus();
    expect(document.activeElement).toBe(menu);
    await interact(() => menu.click());
    const drawer = must(root.querySelector<HTMLElement>('.fy-drawer--overlay'), 'the overlay');
    // Focus moves INTO the drawer (the dialog element is focusable by script), not left on Menu behind it.
    expect(drawer.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(drawer);
    // Tab cycles inside: from the last control it wraps to the first, from the dialog itself Shift+Tab wraps to the last.
    const controls = [...drawer.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = must(controls[0], 'the first control');
    const last = must(controls[controls.length - 1], 'the last control');
    last.focus();
    await interact(() => pressKey(last, 'Tab'));
    expect(document.activeElement).toBe(first);
    drawer.focus();
    await interact(() => pressKey(drawer, 'Tab', { shiftKey: true }));
    expect(document.activeElement).toBe(last);
    expect(drawer.contains(document.activeElement)).toBe(true);
    // Escape shuts it and gives focus back to Menu.
    await interact(() => pressKey(document.activeElement ?? drawer, 'Escape'));
    expect(root.querySelector('.fy-drawer')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('button[aria-label="Menu"]'));
  });
});
