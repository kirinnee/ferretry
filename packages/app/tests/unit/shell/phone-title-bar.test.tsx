import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp } from '@ferretry/kernel/manifest';
import { provideToShell } from '../../../src/connect/provides.ts';
import type { Route } from '../../../src/router/routes.ts';
import { phoneTitleOf } from '../../../src/shell/phone-title-bar.tsx';
import { type Mounted } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf } from './frame-fixtures.tsx';

/**
 * THE PHONE'S TITLE BAR AND THE FIND FIELD (E2 gaps 30, 31). v4 names the page at the top of every phone page, with the
 * ferret list's button on its left and the theme's on its right, and its search is a bordered field with a magnifier.
 */

const manifest = manifestOf('inbox', {
  ui: {
    screens: [
      { id: 'inbox', path: 'inbox', nav: { label: 'Inbox', order: 1 } },
      { id: 'thread', path: 'thread/:ferret', nav: { label: 'Thread', order: 2 } },
    ],
  },
});
const inbox = entryOf(
  manifest,
  provideToShell(
    implementApp(manifest, {
      build: () => ({ screens: { inbox: () => <p>inbox page</p>, thread: () => <p>thread page</p> } }),
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

describe('the phone title bar', () => {
  test('E2 gap 31: a phone page names itself, and the bar has the theme button', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1'], path: '/d/d1/inbox', viewport: 'phone' });
    view = app.view;
    expect(q('[data-slot="phone-title"] h1')?.textContent).toBe('Inbox');
    expect(q('[data-slot="phone-title"] [data-page-theme-switch]')).not.toBeNull();
  });

  test('E2 gap 31: a wide screen has no title bar (the nav already says where you are)', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1'], path: '/d/d1/inbox', viewport: 'wide' });
    view = app.view;
    expect(q('[data-slot="phone-title"]')).toBeNull();
  });

  test("E2 gap 31: a ferret's own page keeps its own header, not a second title", async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1'], path: '/d/d1/thread/f1', viewport: 'phone' });
    view = app.view;
    expect(q('[data-slot="phone-title"]')).toBeNull();
  });

  test('E2 gap 31: the title of each kind of page', () => {
    const screen = { plugin: 'inbox', id: 'inbox', path: 'inbox', label: 'Inbox' };
    const titles = (route: Route) => phoneTitleOf(route)?.title;
    expect(titles({ kind: 'home' })).toBe('Daemons');
    expect(titles({ kind: 'device-settings' })).toBe('Settings');
    expect(titles({ kind: 'daemon-settings', daemon: 'd1' })).toBe('Settings');
    expect(titles({ kind: 'screen', daemon: 'd1', screen, params: {} })).toBe('Inbox');
    expect(titles({ kind: 'screen', daemon: 'd1', screen, params: { ferret: 'f1' } })).toBeUndefined();
    expect(titles({ kind: 'not-found', path: '/x' })).toBeUndefined();
  });
});

describe('the Find field', () => {
  test('E2 gap 30: it is a bordered field with a magnifier and the word Find, and the key hint', async () => {
    const app = await bootApp({ surfaces: [inbox], machines: ['d1'], path: '/d/d1/inbox' });
    view = app.view;
    const find = q('.fy-search');
    expect(find?.querySelector('svg.fy-search__icon')).not.toBeNull();
    expect(find?.querySelector('.fy-search__label')?.textContent).toBe('Find');
    expect(find?.querySelector('kbd')).not.toBeNull();
  });
});
