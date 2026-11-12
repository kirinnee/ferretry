import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest, skeletonApp } from '@ferretry/kernel/manifest';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { App } from '../../../src/shell/app.tsx';
import { PanelSlot } from '../../../src/shell/views.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * The shell drawn end to end against a scripted daemon: the frame, the router, the hash guard and the halves.
 * A plugin whose hash matches draws its screen; one whose hash differs shows the one line; a skeleton shows the
 * skeleton sentence; and no plugin code runs before the bootstrap read.
 */

const boardManifest = {
  id: 'board',
  title: 'Board',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  actions: { routes: [{ key: 'GET /v1/board', minimum: 'authenticated', caller: 'any', audit: 'skip' }] },
  ui: { screens: [{ id: 'board', path: 'board', nav: { label: 'Board', order: 1 } }] },
} as unknown as Manifest;

let built = 0;
const boardApp = implementApp(boardManifest, {
  build: ({ client }) => {
    built += 1;
    return {
      screens: {
        board: () => {
          void client;
          return <p data-testid="board">The board screen</p>;
        },
      },
    };
  },
});

const agendaManifest = {
  id: 'agenda',
  title: 'Agenda',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  ui: { screens: [{ id: 'agenda', path: 'agenda' }] },
} as unknown as Manifest;

const usageManifest = {
  id: 'usage',
  title: 'Usage',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  ui: { screens: [{ id: 'insights', path: 'insights' }] },
} as unknown as Manifest;

const multiManifest = {
  id: 'multi',
  title: 'Multi',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  ui: {
    settings: [
      { id: 'first', label: 'First tab', order: 30 },
      { id: 'second', label: 'Second tab', order: 31 },
      { id: 'third', label: 'Third tab', order: 32 },
    ],
  },
} as unknown as Manifest;

const multiApp = implementApp(multiManifest, {
  build: () => ({
    screens: {},
    settings: {
      first: () => <p data-testid="tab">The first tab</p>,
      second: () => <p data-testid="tab">The second tab</p>,
      third: () => <p data-testid="tab">The third tab</p>,
    },
  }),
});

// A plugin screen that OFFERS a slot (`form.field`), and another plugin that contributes a panel to it.
const picked: string[] = [];
const formManifest = {
  id: 'form',
  title: 'Form',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  ui: { screens: [{ id: 'form', path: 'form' }] },
} as unknown as Manifest;
const formApp = implementApp(formManifest, {
  build: () => ({
    screens: {
      form: () => (
        <PanelSlot
          daemon="d1"
          props={{ value: 'draft', onValueChange: (next: string) => picked.push(next) }}
          slot="form.field"
        />
      ),
    },
  }),
});
const fillerManifest = {
  id: 'filler',
  title: 'Filler',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  ui: { panels: [{ id: 'field-filler', slot: 'form.field', order: 1 }] },
} as unknown as Manifest;
const fillerApp = implementApp(fillerManifest, {
  build: () => ({
    panels: {
      'field-filler': (props: { readonly value?: string; readonly onValueChange?: (next: string) => void }) => (
        <button data-testid="filler" onClick={() => props.onValueChange?.(`${props.value ?? ''}!`)} type="button">
          {props.value}
        </button>
      ),
    },
  }),
});

const entry = (manifest: Manifest, app: SurfaceEntry['app'], contract: string): SurfaceEntry => ({
  id: manifest.id,
  title: manifest.title,
  core: false,
  contract,
  consumes: [],
  manifest,
  ...(app === undefined ? {} : { app }),
});

const surfaces: SurfaceEntry[] = [
  ...CORE,
  entry(boardManifest, boardApp, 'h-board'),
  entry(agendaManifest, skeletonApp(agendaManifest), 'h-agenda'),
  entry(usageManifest, skeletonApp(usageManifest), 'h-usage'),
  entry(multiManifest, multiApp, 'h-multi'),
  entry(formManifest, formApp, 'h-form'),
  entry(fillerManifest, fillerApp, 'h-filler'),
];

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

function setup(daemonContracts: Record<string, string>) {
  const transport = new FakeTransport((request: TransportRequest) => {
    if (request.path === '/v1/plugins') {
      return json(
        inventoryOf(
          surfaces,
          Object.fromEntries(Object.entries(daemonContracts).map(([id, contract]) => [id, { contract }])),
        ),
      );
    }
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    return json({ error: 'none', code: 'not_found' }, 404);
  });
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const runtime = new ShellRuntime({
    appVersion: '5.1.0',
    surfaces,
    daemons,
    connect: async () => transport,
  });
  return { transport, runtime, storage };
}

const go = (path: string): void => window.history.replaceState({}, '', path);
afterEach(() => go('/'));

describe('the app shell', () => {
  test('the home lists daemons grouped by machine', async () => {
    go('/app/');
    const { runtime, storage } = setup({});
    const view = await mount(
      <App
        runtime={runtime}
        themes={new ThemePreferenceStore(storage)}
        layouts={new DeviceLayoutStore(storage)}
        browser={browser}
        scroll={new ScrollMemory(null)}
      />,
    );
    expect(view.container.querySelector('h2')?.textContent).toBe('laptop');
    expect(view.container.textContent).toContain('laptop');
    await view.unmount();
  });

  test('a matching plugin draws its screen, built only after the bootstrap read', async () => {
    go('/d/d1/board');
    built = 0;
    const { runtime, storage, transport } = setup({});
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
    expect(transport.paths().slice(0, 2)).toEqual(['GET /v1/plugins', 'GET /v1/health']);
    expect(view.container.querySelector('[data-testid="board"]')?.textContent).toBe('The board screen');
    expect(built).toBeGreaterThan(0);
    await view.unmount();
  });

  test('a plugin whose hash differs shows the one line and its code never starts', async () => {
    go('/d/d1/board');
    built = 0;
    const { runtime, storage } = setup({ board: 'h-board-next' });
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
    expect(view.container.textContent).toContain('Update this daemon to use Board');
    expect(built).toBe(0);
    await view.unmount();
  });

  test('a skeleton plugin shows the skeleton sentence', async () => {
    go('/d/d1/agenda');
    const { runtime, storage } = setup({});
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
    expect(view.container.textContent).toContain('Not in 5.0 yet: Agenda.');
    await view.unmount();
  });

  test('a core hash mismatch is the one full-screen sentence', async () => {
    go('/d/d1/board');
    const { runtime, storage } = setup({ gate: 'h-gate-next' });
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
    expect(view.container.querySelector('main')?.textContent).toContain('This daemon needs an update');
    await view.unmount();
  });

  test('a plugin that declares several settings tabs draws each one at its own address', async () => {
    const drawn: Record<string, string> = {};
    for (const [path, want] of [
      ['/d/d1/settings/multi', 'The first tab'],
      ['/d/d1/settings/multi/first', 'The first tab'],
      ['/d/d1/settings/multi/second', 'The second tab'],
      ['/d/d1/settings/multi/third', 'The third tab'],
    ] as const) {
      go(path);
      const { runtime, storage } = setup({});
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
      drawn[path] = view.container.querySelector('[data-testid="tab"]')?.textContent ?? '(nothing)';
      expect(drawn[path]).toBe(want);
      const links = [...view.container.querySelectorAll('nav[aria-label="Plugin settings"] a')];
      expect(links.map(link => link.getAttribute('href'))).toEqual([
        '/d/d1/settings/multi/first',
        '/d/d1/settings/multi/second',
        '/d/d1/settings/multi/third',
      ]);
      await view.unmount();
    }
  });

  test('a slot a plugin screen offers draws the panels others contribute, with the props the screen hands it', async () => {
    go('/d/d1/form');
    picked.length = 0;
    const { runtime, storage } = setup({});
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
    const slot = view.container.querySelector('[data-slot="form.field"]');
    expect(slot?.querySelector('[data-panel="filler.field-filler"]')).not.toBeNull();
    const button = view.container.querySelector('[data-testid="filler"]') as HTMLButtonElement | null;
    expect(button?.textContent).toBe('draft');
    await interact(() => button?.click());
    expect(picked).toEqual(['draft!']);
    await view.unmount();
  });

  test('the layout places the nav and publishes the theme on the root', async () => {
    go('/d/d1/board');
    const { runtime, storage } = setup({});
    const themes = new ThemePreferenceStore(storage);
    themes.setFamily('mission');
    const view = await mount(
      <App
        runtime={runtime}
        themes={themes}
        layouts={new DeviceLayoutStore(storage)}
        browser={browser}
        scroll={new ScrollMemory(null)}
      />,
    );
    await settle();
    const nav = view.container.querySelector('nav[data-slot="nav"]');
    expect(nav?.className).toContain('fy-nav--left');
    expect([...(nav?.querySelectorAll('a') ?? [])].map(a => a.getAttribute('href'))).toContain('/d/d1/board');
    expect(document.documentElement.dataset.theme).toBe('mission-light');
    await view.unmount();
  });
});
