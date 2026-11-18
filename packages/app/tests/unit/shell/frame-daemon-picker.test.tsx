import { afterEach, describe, expect, test } from 'bun:test';
import { HOME_HREF } from '../../../src/router/routes.ts';
import { interact, type Mounted, must, pressKey } from '../../support/dom.ts';
import { bootApp, settle } from './frame-fixtures.tsx';

/**
 * THE MACHINE SWITCHER (owner A555 #1): v4's button-and-menu, not a native `<select>`. Every machine is ONE row, the one
 * on screen is marked, "All daemons" leads, and it is a menu button (aria-haspopup, role=menu, arrows, Escape).
 */

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const trigger = (root: ParentNode): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>('button.fy-daemon-picker'), 'the machine switcher');
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const labels = (): string[] => rows().map(row => row.textContent?.trim() ?? '');

describe('the machine switcher', () => {
  test('is a menu button, not a native select, and names the machine on screen', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1', 'd2'], path: '/d/d1' });
    view = app.view;
    expect(app.view.container.querySelector('select')).toBeNull();
    const button = trigger(app.view.container);
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Machine: d1-host. Switch machine');
    expect(button.textContent).toBe('d1-host');
  });

  test('opens a menu listing every machine ONCE, no group header, the current one marked', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1', 'd2', 'd3'], path: '/d/d2' });
    view = app.view;
    await interact(() => trigger(app.view.container).click());
    expect(trigger(app.view.container).getAttribute('aria-expanded')).toBe('true');
    expect(must(document.querySelector('[role="menu"]'), 'the menu').getAttribute('aria-label')).toBe('Switch machine');
    expect(labels()).toEqual(['All daemons', 'd1-host', 'd2-hostthis one', 'd3-host']);
    expect(document.querySelectorAll('[role="group"], optgroup')).toHaveLength(0);
  });

  test('with one machine the menu has the one machine once', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1' });
    view = app.view;
    await interact(() => trigger(app.view.container).click());
    expect(labels()).toEqual(['All daemons', 'd1-hostthis one']);
  });

  test('on the list, "All daemons" is the marked row and the button says so', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1', 'd2'], path: '/', arrived: true });
    view = app.view;
    expect(trigger(app.view.container).textContent).toBe('All daemons');
    await interact(() => trigger(app.view.container).click());
    expect(labels()).toEqual(['All daemonsthis one', 'd1-host', 'd2-host']);
  });

  test('choosing a machine goes to it and selects it; choosing All daemons goes to the list', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1', 'd2'], path: '/d/d1' });
    view = app.view;
    await interact(() => trigger(app.view.container).click());
    await interact(() => rows()[2]?.click());
    await settle();
    expect(window.location.pathname).toBe('/d/d2');
    expect(app.runtime.daemons.snapshot().selected).toBe('d2');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await interact(() => trigger(app.view.container).click());
    await interact(() => rows()[0]?.click());
    await settle();
    expect(window.location.pathname).toBe(HOME_HREF);
  });

  test('keyboard: arrows move, Escape closes and puts focus back on the button', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1', 'd2'], path: '/d/d1' });
    view = app.view;
    const button = trigger(app.view.container);
    button.focus();
    await interact(() => button.click());
    const menu = must(document.querySelector<HTMLElement>('[role="menu"]'), 'the menu');
    await interact(() => pressKey(menu, 'ArrowDown'));
    await interact(() => pressKey(menu, 'Escape'));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
