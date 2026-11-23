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

const layout = (holds: 'panels' | 'desk' = 'panels') => {
  const storage = memoryStore();
  writeRecord(
    storage,
    APP_STORAGE.layout,
    storedOverrides({
      nav: { side: 'left', style: 'list', items: ['desk', 'keeper', 'settings'] },
      side: { holds, show: 'always', at: 'right' },
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

  // The listing is per machine: a machine that turned a surface off does not offer it because ANOTHER machine has it on.
  const twoMachines = async (path: string, holds: 'panels' | 'desk' = 'panels') => {
    const app = await bootApp({
      surfaces: [work, keep],
      machines: ['d1', 'd2'],
      path,
      storage: layout(holds),
      off: { d1: ['agenda'] },
    });
    view = app.view;
    await settle();
    return app;
  };

  test('two machines, d1 off and d2 on: d1 has no nav entry for it, d2 does (item 1)', async () => {
    await twoMachines('/d/d1');
    expect(nav()).not.toContain('Work desk');
    expect(nav()).toContain('Keeper');
    await view?.unmount();
    view = null;
    await twoMachines('/d/d2');
    expect(nav()).toContain('Work desk');
  });

  test('two machines: the finder on d1 offers neither its place nor its settings tab, on d2 it does (item 1)', async () => {
    await twoMachines('/d/d1');
    const off = await openBar('work');
    expect(off).not.toContain('Work desk');
    expect(off).not.toContain('Work tab');
    expect(off).toContain('Keeper');
    await view?.unmount();
    view = null;
    await twoMachines('/d/d2');
    const on = await openBar('work');
    expect(on).toContain('Work desk');
    expect(on).toContain('Work tab');
  });

  test('two machines: a side column a layout fills with the screen is empty on d1 and drawn on d2 (item 1)', async () => {
    await twoMachines('/d/d1', 'desk');
    // (the column is not drawn at all: not the page, and not the off line a screen that cannot run would say instead)
    expect(text()).not.toContain('desk page');
    expect(text()).not.toContain('is off on this daemon');
    expect(document.querySelector('aside.fy-side')).toBeNull();
    await view?.unmount();
    view = null;
    await twoMachines('/d/d2', 'desk');
    expect(text()).toContain('desk page');
  });

  test('two machines: d1 turning it off live takes it out of d1 only', async () => {
    const app = await bootApp({
      surfaces: [work, keep],
      machines: ['d1', 'd2'],
      path: '/d/d1',
      storage: layout(),
    });
    view = app.view;
    await settle();
    expect(nav()).toContain('Work desk');
    app.machine('d1').off.add('agenda');
    await app.reread('d1');
    expect(nav()).not.toContain('Work desk');
  });

  test('a saved deep link to the off settings tab says it is off, never that the tab does not exist (item 3)', async () => {
    await boot('/d/d1/settings/agenda', ['agenda']);
    expect(text()).not.toContain('There is no settings tab');
    expect(text()).toContain('is off on this daemon');
    // the list beside it still leaves the tab out
    expect(document.querySelector('nav[aria-label], .fy-settings-nav')?.textContent ?? '').not.toContain('Work tab');
  });

  test('a name nothing compiled answers to still says so (item 3 keeps its guard)', async () => {
    await boot('/d/d1/settings/nothing-here', ['agenda']);
    expect(text()).toContain('There is no settings tab called "nothing-here"');
  });
});
