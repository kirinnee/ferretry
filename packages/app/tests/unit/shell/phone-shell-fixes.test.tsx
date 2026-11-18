import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp } from '@ferretry/kernel/manifest';
import { provideToShell } from '../../../src/connect/provides.ts';
import { interact, type Mounted } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, settle } from './frame-fixtures.tsx';

/**
 * END-LIST PHONE/NAV SHELL FIXES (EL1): the settings Back link does not ping-pong the history, a phone's bare /settings is
 * the list alone, the title bar is not a second h1, and the phone's bottom bar steps aside for the keyboard.
 */

const demo = manifestOf('demo', {
  ui: {
    screens: [{ id: 'inbox', path: 'inbox', nav: { label: 'Inbox', order: 1 } }],
    settings: [
      { id: 'one', label: 'Tab one', order: 10, group: 'supervision' },
      { id: 'two', label: 'Tab two', order: 11, group: 'health' },
    ],
  },
});
const demoEntry = entryOf(
  demo,
  provideToShell(
    implementApp(demo, {
      build: () => ({
        screens: { inbox: () => <p>inbox page</p> },
        settings: { one: () => <p>one</p>, two: () => <p>two</p> },
      }),
    }),
    {},
  ),
);

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});
const q = (selector: string): Element | null => view?.container.querySelector(selector) ?? null;
const click = async (element: Element | null): Promise<void> => {
  await interact(() => {
    (element as HTMLElement).click();
  });
  await settle();
};

describe('the settings Back link (2006)', () => {
  test('from a panel reached through the list it goes BACK, so the history does not grow a loop', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/settings', viewport: 'phone' });
    view = app.view;
    await click(q('a[href="/d/d1/settings/demo/one"]'));
    expect(window.location.pathname).toBe('/d/d1/settings/demo/one');
    const grown = window.history.length;
    await click(q('.fy-settings-back'));
    expect(window.location.pathname).toBe('/d/d1/settings');
    // A push would have made it grown + 1 (list, panel, list), so a browser Back would return to the panel.
    expect(window.history.length).toBeLessThanOrEqual(grown);
  });

  test('from a deep link into a panel the list REPLACES the panel', async () => {
    const app = await bootApp({
      surfaces: [demoEntry],
      machines: ['d1'],
      path: '/d/d1/settings/demo/one',
      viewport: 'phone',
    });
    view = app.view;
    const before = window.history.length;
    await click(q('.fy-settings-back'));
    expect(window.location.pathname).toBe('/d/d1/settings');
    expect(window.history.length).toBe(before);
  });
});

describe('a phone’s bare /settings (2006)', () => {
  test('is the list alone: no tab marked, no panel mounted behind it', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/settings', viewport: 'phone' });
    view = app.view;
    expect(q('.fy-tab--active')).toBeNull();
    expect(q('.fy-settings-page')).toBeNull();
    expect(q('.fy-settings')?.getAttribute('data-settings-open')).toBe('list');
  });

  test('a wide screen still opens the first tab beside the list', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/settings', viewport: 'wide' });
    view = app.view;
    expect(q('.fy-tab--active')?.textContent).toBe('Tab one');
    expect(q('.fy-settings-page')).not.toBeNull();
  });

  test('a named tab on a phone still opens its panel', async () => {
    const app = await bootApp({
      surfaces: [demoEntry],
      machines: ['d1'],
      path: '/d/d1/settings/demo/two',
      viewport: 'phone',
    });
    view = app.view;
    expect(q('.fy-tab--active')?.textContent).toBe('Tab two');
    expect(q('.fy-settings-page')).not.toBeNull();
  });
});

describe('one h1 per phone page (2016)', () => {
  test('Settings draws its own h1, so the title bar is not a second one', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/settings', viewport: 'phone' });
    view = app.view;
    expect(view.container.querySelectorAll('h1').length).toBe(1);
    expect(q('[data-slot="phone-title"] h1')).toBeNull();
    expect(q('[data-slot="phone-title"] .fy-phone-title__text')?.textContent).toBe('Settings');
  });

  test('a page with no h1 of its own keeps the bar as its h1', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/inbox', viewport: 'phone' });
    view = app.view;
    expect(view.container.querySelectorAll('h1').length).toBe(1);
    expect(q('[data-slot="phone-title"] h1')?.textContent).toBe('Inbox');
  });
});

describe('the bottom bar and the keyboard (U-M)', () => {
  test('the phone’s bottom bar is marked to step aside while the keyboard is up', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/inbox', viewport: 'phone' });
    view = app.view;
    expect(q('nav[data-slot="bottom"]')?.hasAttribute('data-kb-hide')).toBe(true);
  });

  test('a wide screen’s nav is never marked', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/inbox', viewport: 'wide' });
    view = app.view;
    expect(q('nav.fy-nav')?.hasAttribute('data-kb-hide')).toBe(false);
  });
});
