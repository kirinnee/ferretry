import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { NotificationOpenInbox, notificationOpenMessage } from '../../../src/worker/notification-open.ts';
import { interact, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * S6, "a tap before the router is up is routed when it is": the inbox holds a tap made before React mounted, and the
 * app root — not a test calling the function itself — subscribes it once the router exists, navigates to the landing and
 * tells the plugins of the machine it landed under.
 */

const boardManifest = {
  id: 'board',
  title: 'Board',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  ui: { screens: [{ id: 'board', path: 'board', nav: { label: 'Board', order: 1 } }] },
} as unknown as Manifest;

const heard: unknown[] = [];

const boardApp = {
  ...implementApp(boardManifest, {
    build: () => ({ screens: { board: () => <p data-testid="board">The board screen</p> } }),
  }),
  shell: {
    notificationOpened: (context: { daemon: string; client: unknown }, tap: unknown) =>
      void heard.push([context.daemon, context.client !== undefined, tap]),
  },
};

const surfaces: SurfaceEntry[] = [
  ...CORE,
  {
    id: 'board',
    title: 'Board',
    core: false,
    contract: 'h-board',
    consumes: [],
    manifest: boardManifest,
    app: boardApp as never,
  },
];

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

function setup(inbox: NotificationOpenInbox | undefined) {
  const transport = new FakeTransport((request: TransportRequest) => {
    if (request.path === '/v1/plugins') return json(inventoryOf(surfaces));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    return json({ error: 'none', code: 'not_found' }, 404);
  });
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons,
    connect: async () => transport,
    ...(inbox === undefined ? {} : { notificationOpens: inbox }),
  });
  return { runtime, storage };
}

/** The page of a tap the worker sent, as the inbox receives it. */
const tap = (inbox: NotificationOpenInbox, path: string, tag?: string): void =>
  inbox.receive({ data: notificationOpenMessage(`${window.location.origin}${path}`, tag), ports: [] as never });

const go = (path: string): void => window.history.replaceState({}, '', path);
afterEach(() => go('/'));

const render = async (runtime: ShellRuntime, storage: ReturnType<typeof memoryStore>) =>
  await mount(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />,
  );

describe('S6 the app root mounts the notification taps', () => {
  test('a tap held before the router was up is routed when it is, and the plugin hears the checked page and tag', async () => {
    go('/app/');
    heard.length = 0;
    const inbox = new NotificationOpenInbox(window.location.origin);
    // The worker's message arrives while the app is still starting: nobody is subscribed yet, so the inbox holds it.
    tap(inbox, '/d/d1/board', 'agenda-A3');
    const { runtime, storage } = setup(inbox);
    // The machine's connection is up (a plugin is only told over a client that is allowed on a connected machine).
    runtime.connection('d1');
    await new Promise(resolve => setTimeout(resolve, 20));
    const view = await render(runtime, storage);
    await settle();
    expect(window.location.pathname).toBe('/d/d1/board');
    expect(view.container.querySelector('[data-testid="board"]')?.textContent).toBe('The board screen');
    expect(heard).toEqual([['d1', true, { url: '/d/d1/board', tag: 'agenda-A3' }]]);
    await view.unmount();
  });

  test('a tap that arrives while the app is up is routed at once', async () => {
    go('/app/');
    heard.length = 0;
    const inbox = new NotificationOpenInbox(window.location.origin);
    const { runtime, storage } = setup(inbox);
    const view = await render(runtime, storage);
    await settle();
    expect(window.location.pathname).toBe('/app/');
    await interact(async () => tap(inbox, '/d/d1/board'));
    await settle();
    expect(window.location.pathname).toBe('/d/d1/board');
    expect(heard).toEqual([['d1', true, { url: '/d/d1/board' }]]);
    await view.unmount();
  });

  test('a tap naming a machine this browser never paired lands on the app’s home and tells no plugin', async () => {
    go('/d/d1/board');
    heard.length = 0;
    const inbox = new NotificationOpenInbox(window.location.origin);
    const { runtime, storage } = setup(inbox);
    const view = await render(runtime, storage);
    await settle();
    await interact(async () => tap(inbox, '/d/stranger/board', 'agenda-A3'));
    await settle();
    expect(window.location.pathname).toBe('/app/');
    expect(heard).toEqual([]);
    await view.unmount();
  });

  test('with no inbox nothing is mounted and the app stays where it was', async () => {
    go('/app/');
    heard.length = 0;
    const { runtime, storage } = setup(undefined);
    const view = await render(runtime, storage);
    await settle();
    expect(window.location.pathname).toBe('/app/');
    expect(heard).toEqual([]);
    await view.unmount();
  });
});
