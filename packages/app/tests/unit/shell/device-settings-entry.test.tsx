import { afterEach, describe, expect, test } from 'bun:test';
import { interact, type Mounted } from '../../support/dom.ts';
import { bootApp } from './frame-fixtures.tsx';

/**
 * THIS DEVICE LIVES INSIDE SETTINGS: with a machine to put it in, the old bare `/settings` address (a bookmark) opens the
 * section `/d/<daemon>/settings/device`; with none (an unpaired device) or with a machine whose pages are blocked, the
 * standalone recovery page stays, because there is nothing to draw it inside of.
 */

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  window.history.replaceState(null, '', '/');
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

describe('the old /settings bookmark', () => {
  test('on a paired device it becomes the section inside the machine’s Settings', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1'], path: '/settings' });
    view = app.view;
    await settle();
    expect(window.location.pathname).toBe('/d/d1/settings/device');
    // The nav list is on screen beside the section: it is no longer the standalone page.
    expect(view.container.querySelector('nav[aria-label="Plugin settings"]')).not.toBeNull();
    expect(view.container.querySelector('.fy-settings-page[aria-label="This device"]')).not.toBeNull();
  });

  test('on an unpaired device it stays the standalone recovery page', async () => {
    const app = await bootApp({ surfaces: [], machines: [], path: '/settings' });
    view = app.view;
    await settle();
    expect(window.location.pathname).toBe('/settings');
    expect(view.container.querySelector('h1')?.textContent).toBe('This device');
    expect(view.container.querySelector('nav[aria-label="Plugin settings"]')).toBeNull();
  });
});
