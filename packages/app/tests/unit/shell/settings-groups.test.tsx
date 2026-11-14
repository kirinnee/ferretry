import { afterEach, describe, expect, test } from 'bun:test';
import { SETTINGS_GROUPS } from '@ferretry/kernel/manifest';
import { generated } from '../../../src/generated/surfaces.ts';
import { groupSettingsTabs } from '../../../src/shell/settings-tab.ts';
import type { Mounted } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, settle } from './frame-fixtures.tsx';

/**
 * SETTINGS IS GROUPED, AND THIS DEVICE IS ONE CLICK AWAY (s6 R2-5, R2-7). v4 listed a machine's panels under titled
 * groups (`machine-panels.ts`: Supervision, More agent settings, Sites and secrets, Devices & access, Health, Tools,
 * Advanced, About) and reached "This device" from Settings; 5.0 drew one row of every tab and only Ctrl+K reached the
 * device page. A plugin names its tab's group in its manifest, so the shell never names a plugin.
 */

const tab = (plugin: string, id: string, group?: string, order = 0) => ({
  plugin,
  id,
  label: id,
  order,
  ...(group === undefined ? {} : { group }),
});

describe('groupSettingsTabs', () => {
  test('lists each group once, in the shell’s order, with its tabs in their own order', () => {
    const groups = groupSettingsTabs([
      tab('a', 'files', 'advanced', 90),
      tab('b', 'logins', 'agents', 25),
      tab('c', 'warden', 'supervision', 60),
      tab('d', 'runtimes', 'agents', 10),
    ] as never);
    expect(groups.map(group => [group.label, group.tabs.map(entry => entry.id)])).toEqual([
      ['Agents and logins', ['runtimes', 'logins']],
      ['Supervision', ['warden']],
      ['Advanced', ['files']],
    ]);
  });

  test('a tab that names no group (or one the shell does not know) is listed last, under More, never dropped', () => {
    const groups = groupSettingsTabs([
      tab('a', 'lonely'),
      tab('b', 'odd', 'nonesuch'),
      tab('c', 'warden', 'supervision'),
    ] as never);
    expect(groups.map(group => [group.label, group.tabs.map(entry => entry.id)])).toEqual([
      ['Supervision', ['warden']],
      ['More', ['lonely', 'odd']],
    ]);
  });
});

describe('every settings tab a shipped plugin declares belongs to a group', () => {
  test('names a group the shell knows', () => {
    const known = new Set<string>(SETTINGS_GROUPS.map(group => group.id));
    const loose = generated.surfaces.flatMap(entry =>
      (entry.manifest.ui?.settings ?? [])
        .filter(setting => setting.group === undefined || !known.has(setting.group))
        .map(setting => `${entry.id}/${setting.id}`),
    );
    expect(loose).toEqual([]);
  });
});

const demo = manifestOf('demo', {
  ui: {
    settings: [
      { id: 'one', label: 'Tab one', order: 10, group: 'supervision' },
      { id: 'two', label: 'Tab two', order: 11, group: 'health' },
    ],
  },
});
const demoEntry = entryOf(demo, {
  screens: {},
  settings: { one: () => <p>one</p>, two: () => <p>two</p> },
} as never);

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('the daemon Settings page', () => {
  test('draws each group under its heading, and no flat row of tabs', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/settings' });
    view = app.view;
    await settle();
    const nav = view.container.querySelector('nav[aria-label="Plugin settings"]') as HTMLElement;
    const groups = [...nav.querySelectorAll('.fy-tab-group')].map(group => ({
      heading: group.querySelector('h2')?.textContent,
      links: [...group.querySelectorAll('a')].map(link => link.textContent),
    }));
    expect(groups).toEqual([
      { heading: 'Supervision', links: ['Tab one'] },
      { heading: 'Health', links: ['Tab two'] },
    ]);
  });

  test('reaches This device from Settings, at the address that survives a reload', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/d/d1/settings' });
    view = app.view;
    await settle();
    const link = [...view.container.querySelectorAll('a')].find(a => a.textContent === 'This device');
    expect(link?.getAttribute('href')).toBe('/settings');
  });

  test('This device points back at the daemon’s Settings when one is paired', async () => {
    const app = await bootApp({ surfaces: [demoEntry], machines: ['d1'], path: '/settings' });
    view = app.view;
    await settle();
    const hrefs = [...view.container.querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/d/d1/settings');
  });
});
