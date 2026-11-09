import { describe, expect, test } from 'bun:test';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { routeTable } from '../../../src/router/routes.ts';
import { PUSH_TAP_SCREENS } from '../../../src/router/tap-target.ts';
import { openNotificationTap, tapLanding } from '../../../src/shell/notification-taps.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from '../client/fixtures.ts';

const ORIGIN = 'https://app.test';
const routes = routeTable(PUSH_TAP_SCREENS);
const paired =
  (...daemons: string[]) =>
  (daemon: string) =>
    daemons.includes(daemon);

describe('S6 tapLanding (the page’s own check of where a tap lands)', () => {
  test('keeps an accepted page under a paired machine, with its query', () => {
    expect(tapLanding({ path: '/d/a/ferrets/f1/chat?ask=A3' }, ORIGIN, routes, paired('a'))).toEqual({
      url: '/d/a/ferrets/f1/chat?ask=A3',
      daemon: 'a',
    });
  });

  test('a machine this browser never paired lands on the app’s home, with no machine to tell', () => {
    for (const path of ['/d/stranger/ferrets/f1/chat?ask=A3', '/d/stranger', '/d/stranger/unknown']) {
      const landing = tapLanding({ path }, ORIGIN, routes, paired('a'));
      expect(landing.daemon).toBeUndefined();
      expect(landing.url).toBe('/app/');
    }
  });

  test('an unknown page under a paired machine lands on that machine’s home', () => {
    expect(tapLanding({ path: '/d/a/no/such/page' }, ORIGIN, routes, paired('a'))).toEqual({
      url: '/d/a',
      daemon: 'a',
    });
  });

  test('anything off the routing table lands on the app’s home', () => {
    for (const path of ['/', '/join#code', '//evil.test/d/a', 'javascript:alert(1)']) {
      expect(tapLanding({ path }, ORIGIN, routes, paired('a')).url).toBe('/app/');
    }
  });
});

const withShell = (id: string, shell: object): SurfaceEntry =>
  ({ ...surface(id), app: { skeleton: false, shell } }) as unknown as SurfaceEntry;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

async function connected(shell: object) {
  const surfaces = [...CORE, withShell('conversation', shell)];
  const transport = new FakeTransport((request: TransportRequest) =>
    request.path === '/v1/plugins' ? json(inventoryOf(surfaces)) : json({ protocol: 1, version: '5.0.0' }),
  );
  const daemons = new DaemonList({ storage: memoryStore(), now: () => 1 });
  const base = { machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' };
  daemons.add({ ...base, daemon: 'a' });
  daemons.add({ ...base, daemon: 'b' });
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons,
    connect: async () => transport,
  });
  runtime.connection('a');
  await settle();
  return { runtime };
}

describe('S6 a tap reaches the plugins of the machine it landed under, and only that machine', () => {
  test('routes the page, then tells each plugin that asked, with the tag and over its own client', async () => {
    const heard: unknown[] = [];
    const { runtime } = await connected({
      notificationOpened: (context: { daemon: string; client: unknown }, tap: unknown) =>
        void heard.push([context.daemon, context.client !== undefined, tap]),
    });
    const navigated: string[] = [];
    openNotificationTap(
      { path: '/d/a/ferrets/f1/chat?ask=A3', tag: 'agenda-A3' },
      { origin: ORIGIN, runtime, routes, navigate: to => void navigated.push(to) },
    );
    expect(navigated).toEqual(['/d/a/ferrets/f1/chat?ask=A3']);
    expect(heard).toEqual([['a', true, { url: '/d/a/ferrets/f1/chat?ask=A3', tag: 'agenda-A3' }]]);
  });

  test('a tap with no tag tells the plugin the page only', async () => {
    const heard: unknown[] = [];
    const { runtime } = await connected({ notificationOpened: (_: unknown, tap: unknown) => void heard.push(tap) });
    openNotificationTap({ path: '/d/a' }, { origin: ORIGIN, runtime, routes, navigate: () => {} });
    expect(heard).toEqual([{ url: '/d/a' }]);
  });

  test('a machine this browser never paired is told nothing; the tap lands on the app’s home', async () => {
    const heard: unknown[] = [];
    const { runtime } = await connected({ notificationOpened: (_: unknown, tap: unknown) => void heard.push(tap) });
    const navigated: string[] = [];
    openNotificationTap(
      { path: '/d/stranger/ferrets/f1/chat?ask=A3', tag: 'agenda-A3' },
      { origin: ORIGIN, runtime, routes, navigate: to => void navigated.push(to) },
    );
    expect(navigated).toEqual(['/app/']);
    expect(heard).toEqual([]);
  });

  test('a paired machine with no connection yet has no client, so nobody is told', async () => {
    const heard: unknown[] = [];
    const { runtime } = await connected({ notificationOpened: (_: unknown, tap: unknown) => void heard.push(tap) });
    runtime.notificationOpened('b', { url: '/d/b', tag: 'agenda-A3' });
    expect(heard).toEqual([]);
  });

  test('one plugin throwing or rejecting costs only itself', async () => {
    const heard: unknown[] = [];
    const surfaces = [
      ...CORE,
      withShell('conversation', {
        notificationOpened: () => {
          throw new Error('conversation failed');
        },
      }),
      withShell('agenda', { notificationOpened: () => Promise.reject(new Error('agenda failed')) }),
      withShell('board', { notificationOpened: (_: unknown, tap: unknown) => void heard.push(tap) }),
    ];
    const transport = new FakeTransport((request: TransportRequest) =>
      request.path === '/v1/plugins' ? json(inventoryOf(surfaces)) : json({ protocol: 1, version: '5.0.0' }),
    );
    const daemons = new DaemonList({ storage: memoryStore(), now: () => 1 });
    daemons.add({ daemon: 'a', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
    const runtime = new ShellRuntime({ appVersion: '5.0.0', surfaces, daemons, connect: async () => transport });
    runtime.connection('a');
    await settle();
    runtime.notificationOpened('a', { url: '/d/a' });
    await settle();
    expect(heard).toEqual([{ url: '/d/a' }]);
  });
});
