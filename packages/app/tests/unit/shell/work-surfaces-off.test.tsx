import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { provideToShell } from '../../../src/connect/provides.ts';
import { storedOverrides } from '../../../src/layout/device-layout.ts';
import type { LayoutOverrides } from '../../../src/layout/layout.ts';
import { APP_STORAGE } from '../../../src/storage/names.ts';
import { memoryStore, writeRecord } from '../../../src/storage/records.ts';
import { interact, type Mounted } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, settle } from './frame-fixtures.tsx';

/**
 * O8-14 P3: with the work switch off the daemon's inventory says Board and Agenda are `off`, and the app then draws no
 * trace of them: not in the nav, the settings list, the destination finder, the nav panel or the device settings. With
 * the switch on, the same app draws all of them. One surface here stands for both (they share the one answer).
 */

const workManifest = manifestOf('agenda', {
  ui: {
    screens: [{ id: 'desk', path: 'desk', nav: { label: 'Work desk', order: 1 } }],
    settings: [{ id: 'work-tab', label: 'Work tab', order: 10, group: 'behaviour' }],
    panels: [
      { id: 'needs-you', slot: 'nav', order: 10 },
      { id: 'work-mute', slot: 'device.settings', order: 10 },
    ],
  },
});
const work = entryOf(
  workManifest,
  provideToShell(implementApp(workManifest, { build: () => ({ screens: { desk: () => <p>desk page</p> } }) }), {
    navPanels: { 'needs-you': (): ReactNode => <p data-testid="needs-you">Needs you</p> },
    deviceSettings: { 'work-mute': (): ReactNode => <p data-testid="work-mute">Mute work</p> },
  }),
);

const keepManifest = manifestOf('keep', {
  ui: {
    screens: [{ id: 'keeper', path: 'keeper', nav: { label: 'Keeper', order: 2 } }],
    settings: [{ id: 'keep-tab', label: 'Keep tab', order: 11, group: 'behaviour' }],
  },
});
const keep = entryOf(
  keepManifest,
  provideToShell(implementApp(keepManifest, { build: () => ({ screens: { keeper: () => <p>keeper page</p> } }) }), {}),
);

const layout = () => {
  const storage = memoryStore();
  writeRecord(
    storage,
    APP_STORAGE.layout,
    storedOverrides({
      nav: { side: 'left', style: 'list', items: ['desk', 'keeper', 'settings'] },
      side: { holds: 'panels' },
      panels: { 'ferret.side': [] },
      'composer.tools': [],
    } as LayoutOverrides),
  );
  return storage;
};

const text = (): string => document.body.textContent ?? '';
const nav = (): string => document.querySelector('nav')?.textContent ?? '';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const boot = async (path: string, off: readonly string[]) => {
  const app = await bootApp({
    surfaces: [work, keep],
    machines: ['d1'],
    path,
    storage: layout(),
    off: { d1: off },
  });
  view = app.view;
  await settle();
  return app;
};

const barText = (): string => document.querySelector('[role="dialog"]')?.textContent ?? '';

/** Opens the finder and searches for `query`: the resting list and the matches for it, as one string. */
const openBar = async (query: string): Promise<string> => {
  await interact(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  });
  await settle();
  const resting = barText();
  const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]');
  if (input === null) throw new Error('no query box');
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  return `${resting} | ${barText()}`;
};

describe('a surface its daemon has turned off is offered nowhere (O8-14 P3)', () => {
  test('off: no nav entry, no needs-you panel, the others stay', async () => {
    await boot('/d/d1', ['agenda']);
    expect(nav()).not.toContain('Work desk');
    expect(nav()).toContain('Keeper');
    expect(document.querySelector('[data-testid="needs-you"]')).toBeNull();
  });

  test('on: the nav entry and the needs-you panel are there', async () => {
    await boot('/d/d1', []);
    expect(nav()).toContain('Work desk');
    expect(nav()).toContain('Keeper');
    expect(document.querySelector('[data-testid="needs-you"]')).not.toBeNull();
  });

  test('off: no settings tab for it, the other tabs stay', async () => {
    await boot('/d/d1/settings', ['agenda']);
    expect(text()).not.toContain('Work tab');
    expect(text()).toContain('Keep tab');
  });

  test('on: its settings tab is listed', async () => {
    await boot('/d/d1/settings', []);
    expect(text()).toContain('Work tab');
    expect(text()).toContain('Keep tab');
  });

  test('off: no device settings panel (the mute toggles)', async () => {
    await boot('/settings', ['agenda']);
    expect(document.querySelector('[data-testid="work-mute"]')).toBeNull();
  });

  test('on: the device settings panel is drawn', async () => {
    await boot('/settings', []);
    expect(document.querySelector('[data-testid="work-mute"]')).not.toBeNull();
  });

  test('off: the destination finder offers neither its place nor its settings tab', async () => {
    await boot('/d/d1', ['agenda']);
    const bar = await openBar('work');
    expect(bar).not.toContain('Work desk');
    expect(bar).not.toContain('Work tab');
    expect(bar).toContain('Keeper');
  });

  test('on: the destination finder offers both', async () => {
    await boot('/d/d1', []);
    const bar = await openBar('work');
    expect(bar).toContain('Work desk');
    expect(bar).toContain('Work tab');
  });

  test('it follows the inventory live: turned on, it appears; turned off, it goes', async () => {
    const app = await boot('/d/d1', ['agenda']);
    expect(nav()).not.toContain('Work desk');
    app.machine('d1').off.delete('agenda');
    await app.reread('d1');
    expect(nav()).toContain('Work desk');
    app.machine('d1').off.add('agenda');
    await app.reread('d1');
    expect(nav()).not.toContain('Work desk');
  });

  test('a deep link to the off surface still says it is off (nothing silently 404s)', async () => {
    await boot('/d/d1/desk', ['agenda']);
    expect(text()).toContain('is off on this daemon');
  });

  test('with two machines it stays while ANY of them has it on', async () => {
    const app = await bootApp({
      surfaces: [work, keep],
      machines: ['d1', 'd2'],
      path: '/d/d2',
      storage: layout(),
      off: { d1: ['agenda'] },
    });
    view = app.view;
    await settle();
    expect(nav()).toContain('Work desk');
  });
});
