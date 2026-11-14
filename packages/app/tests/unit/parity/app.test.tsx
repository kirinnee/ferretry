import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import type { ScreenRef } from '../../../src/layout/engine.ts';
import { daemonHomeHref, daemonSettingsHref, routeTable } from '../../../src/router/routes.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * The app shell's parity rows (docs/design/rebuild-parity.tsv, owner `app`): the shell owns only the frame's own pages,
 * so each row is proved by the router's pure parse or by the shell drawn against a scripted daemon. Every other screen
 * is a plugin's, and its row names that plugin's own test (or `none yet`). A row ticked here has its id in a test title.
 */

const table = routeTable([]);
const screen = (path: string, id = 'screen'): ScreenRef => ({ plugin: 'demo', id, path, label: 'Demo' });

// A plugin with two settings tabs and a panel in the daemon's status slot: what the shell draws on those pages.
const demoManifest = {
  id: 'demo',
  title: 'Demo',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  ui: {
    settings: [
      { id: 'first', label: 'First tab', order: 30 },
      { id: 'second', label: 'Second tab', order: 31 },
    ],
    panels: [{ id: 'status-line', slot: 'daemon.status', order: 1 }],
  },
} as unknown as Manifest;
const demoApp = implementApp(demoManifest, {
  build: () => ({
    screens: {},
    settings: {
      first: () => <p data-testid="tab">The first tab</p>,
      second: () => <p data-testid="tab">The second tab</p>,
    },
    panels: { 'status-line': () => <p data-testid="status">The daemon status panel</p> },
  }),
});
const surfaces: SurfaceEntry[] = [
  ...CORE,
  {
    id: demoManifest.id,
    title: demoManifest.title,
    core: false,
    contract: 'h-demo',
    consumes: [],
    manifest: demoManifest,
    app: demoApp,
  },
];

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};
const go = (path: string): void => window.history.replaceState({}, '', path);
afterEach(() => go('/'));

/** The shell at `path`, with one paired daemon `d1` on machine `laptop`. */
async function drawn(path: string) {
  go(path);
  const transport = new FakeTransport((request: TransportRequest) => {
    if (request.path === '/v1/plugins') return json(inventoryOf(surfaces, {}));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    return json({ error: 'none', code: 'not_found' }, 404);
  });
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const runtime = new ShellRuntime({ appVersion: '5.1.0', surfaces, daemons, connect: async () => transport });
  const view = await mount(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />,
  );
  await settle();
  return view;
}

describe('the shell home: the daemon list at `/`', () => {
  test('S-0362 `/` (and the installed `/app/`) is the home route', () => {
    expect(table.parse('/')).toEqual({ kind: 'home' });
    expect(table.parse('/app/')).toEqual({ kind: 'home' });
  });

  test('S-0392 the home draws the paired daemons grouped by machine, each with its home and settings links', async () => {
    const view = await drawn('/app/');
    expect(view.container.querySelector('h1')?.textContent).toBe('Daemons');
    expect(view.container.querySelector('h2')?.textContent).toBe('laptop');
    const hrefs = [...view.container.querySelectorAll('li a')].map(link => link.getAttribute('href'));
    expect(hrefs).toEqual([daemonHomeHref('d1'), daemonSettingsHref('d1')]);
    await view.unmount();
  });
});

describe('the daemon home: `/d/<id>`', () => {
  test('S-0370 `/d/<id>` is that daemon’s home, and the id is percent-decoded', () => {
    expect(table.parse('/d/d1')).toEqual({ kind: 'daemon-home', daemon: 'd1' });
    expect(table.parse('/d/a%20b')).toEqual({ kind: 'daemon-home', daemon: 'a b' });
    expect(daemonHomeHref('a b')).toBe('/d/a%20b');
    expect(table.parse('/d/')).toEqual({ kind: 'not-found', path: '/d/' });
  });

  test('S-0393 the daemon home names the daemon and draws its status panels', async () => {
    const view = await drawn('/d/d1');
    expect(view.container.querySelector('h1')?.textContent?.length).toBeGreaterThan(0);
    expect(view.container.querySelector('[data-testid="status"]')?.textContent).toBe('The daemon status panel');
    await view.unmount();
  });

  test('S-0113 the daemon home of a daemon this device is not paired with says so and draws no panel', async () => {
    const view = await drawn('/d/unknown');
    expect(view.container.textContent).toContain('This device is not paired with that daemon.');
    expect(view.container.querySelector('[data-testid="status"]')).toBeNull();
    await view.unmount();
  });

  test('S-0343 the home page is the `daemon.status` slot: a plugin’s panel in it appears with no screen of its own', async () => {
    const view = await drawn('/d/d1');
    expect(view.container.querySelectorAll('[data-testid="status"]').length).toBe(1);
    await view.unmount();
  });
});

describe('the settings pages: `/settings` and `/d/<id>/settings[/<plugin>[/<tab>]]`', () => {
  test('S-0381 the daemon settings route, with an optional plugin and tab, and nothing past the tab', () => {
    expect(table.parse('/d/d1/settings')).toEqual({ kind: 'daemon-settings', daemon: 'd1' });
    expect(table.parse('/d/d1/settings/demo')).toEqual({ kind: 'daemon-settings', daemon: 'd1', tab: 'demo' });
    expect(table.parse('/d/d1/settings/demo/second')).toEqual({
      kind: 'daemon-settings',
      daemon: 'd1',
      tab: 'demo',
      tabId: 'second',
    });
    expect(table.parse('/d/d1/settings/demo/second/extra')).toEqual({
      kind: 'not-found',
      path: '/d/d1/settings/demo/second/extra',
    });
    expect(daemonSettingsHref('d1', 'demo', 'second')).toBe('/d/d1/settings/demo/second');
  });

  test('S-0406 a plugin screen cannot take the `settings` segment from the shell', () => {
    expect(routeTable([screen('settings')]).parse('/d/d1/settings')).toEqual({ kind: 'daemon-settings', daemon: 'd1' });
    expect(routeTable([screen('/settings')]).parse('/settings')).toEqual({ kind: 'device-settings' });
  });

  test('S-0234 the settings page lists one tab per plugin setting, in order, each at its own address', async () => {
    const view = await drawn('/d/d1/settings');
    expect(view.container.querySelector('h1')?.textContent).toBe('Settings');
    const links = [...view.container.querySelectorAll('nav[aria-label="Plugin settings"] a')];
    expect(links.map(link => link.getAttribute('href'))).toContain('/d/d1/settings/demo/first');
    expect(links.map(link => link.getAttribute('href'))).toContain('/d/d1/settings/demo/second');
    await view.unmount();
  });

  test('S-0235 the settings route draws the tab its address names, and the plugin’s first tab for `settings/<plugin>`', async () => {
    for (const [path, want] of [
      ['/d/d1/settings/demo', 'The first tab'],
      ['/d/d1/settings/demo/second', 'The second tab'],
    ] as const) {
      const view = await drawn(path);
      expect(view.container.querySelector('[data-testid="tab"]')?.textContent).toBe(want);
      await view.unmount();
    }
  });

  test('S-0355 `/settings` is this device’s settings page, a separate page from any daemon’s', async () => {
    expect(table.parse('/settings')).toEqual({ kind: 'device-settings' });
    const view = await drawn('/settings');
    expect(view.container.querySelector('nav[aria-label="Plugin settings"]')).toBeNull();
    await view.unmount();
  });
});

describe('manifest routes', () => {
  test('S-0385 a manifest screen’s path is its address: relative per daemon, absolute daemon-less, parameters encoded', () => {
    const card = screen('board/:card', 'card');
    const optional = screen('board/:project?', 'board');
    const join = screen('/join', 'join');
    const routes = routeTable([card, optional, join]);
    expect(routes.href(card, { card: 'F 12' }, 'd1')).toBe('/d/d1/board/F%2012');
    expect(routes.parse('/d/d1/board/F%2012')).toEqual({
      kind: 'screen',
      daemon: 'd1',
      screen: card,
      params: { card: 'F 12' },
    });
    expect(routes.href(optional, {}, 'd1')).toBe('/d/d1/board');
    expect(routes.href(join, {})).toBe('/join');
    expect(routes.parse('/join')).toEqual({ kind: 'screen', screen: join, params: {} });
    expect(() => routes.href(card, {}, 'd1')).toThrow(TypeError);
  });
});
