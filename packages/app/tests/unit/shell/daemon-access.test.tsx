import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import { useEffect, useState } from 'react';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { usePairedDaemons } from '../../../src/shell/daemon-access.ts';
import { type DaemonReach, useEveryDaemon } from '../../../src/shell/every-daemon.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from '../client/fixtures.ts';

/**
 * A page that reads several daemons: the paired list, live, and the page's own plugin's row on each of them
 * (`useEveryDaemon`), which appears once that daemon's inventory allows the plugin and never for one that does not.
 */

const manifest = {
  id: 'reach',
  title: 'Reach',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  actions: { routes: [{ key: 'GET /v1/reach', minimum: 'authenticated', caller: 'any', audit: 'skip' }] },
  ui: { screens: [{ id: 'reach', path: 'reach' }] },
} as unknown as Manifest;

let rows: readonly DaemonReach[] = [];
let listed: readonly string[] = [];

const app = implementApp(manifest, {
  build: () => ({
    screens: {
      reach: () => {
        const daemons = usePairedDaemons();
        const every = useEveryDaemon();
        const [answer, setAnswer] = useState('waiting');
        listed = daemons.map(daemon => daemon.daemon);
        rows = every;
        const there = every.find(row => row.daemon === 'd2')?.client;
        useEffect(() => {
          if (there === undefined) return;
          let live = true;
          void there.call<{ ok: boolean }>('GET /v1/reach').then(body => live && setAnswer(`ok:${body.ok}`));
          return () => {
            live = false;
          };
        }, [there]);
        return <p data-testid="answer">{answer}</p>;
      },
    },
  }),
});

const entry: SurfaceEntry = {
  ...surface('reach', { routes: ['GET /v1/reach'] }),
  manifest,
  app,
};
const surfaces: SurfaceEntry[] = [...CORE, entry];

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

function setup(secondInventory: Parameters<typeof inventoryOf>[1] = {}) {
  const scripted = (inventory: Parameters<typeof inventoryOf>[1]) =>
    new FakeTransport((request: TransportRequest) => {
      if (request.path === '/v1/plugins') return json(inventoryOf(surfaces, inventory));
      if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
      if (request.path === '/v1/reach') return json({ ok: true });
      return json({ error: 'none', code: 'not_found' }, 404);
    });
  const here = scripted({});
  const there = scripted(secondInventory);
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  daemons.add({ daemon: 'd2', machine: 'desk', deviceId: 'dev', address: 'http://127.0.0.1:40246' });
  daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const runtime = new ShellRuntime({
    appVersion: '5.1.0',
    surfaces,
    daemons,
    connect: async paired => (paired.daemon === 'd2' ? there : here),
  });
  return { runtime, storage, daemons, there };
}

const draw = (runtime: ShellRuntime, storage: ReturnType<typeof memoryStore>) =>
  mount(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />,
  );

afterEach(() => {
  window.history.replaceState({}, '', '/');
  rows = [];
  listed = [];
});

describe('reaching the other paired daemons', () => {
  test('the paired list is live, and the page reads another daemon through its own row there', async () => {
    window.history.replaceState({}, '', '/d/d1/reach');
    const { runtime, storage, daemons } = setup();
    const view = await draw(runtime, storage);
    await settle();
    expect([...listed].sort()).toEqual(['d1', 'd2']);
    expect(view.container.querySelector('[data-testid="answer"]')?.textContent).toBe('ok:true');
    await interact(() => daemons.remove('d2'));
    await settle();
    expect(listed).toEqual(['d1']);
    expect(rows.map(row => row.daemon)).toEqual(['d1']);
    await view.unmount();
  });

  test('a daemon that does not allow the package has no row, and nothing is sent to it', async () => {
    window.history.replaceState({}, '', '/d/d1/reach');
    const { runtime, storage, there } = setup({ reach: { on: false } });
    const view = await draw(runtime, storage);
    await settle();
    expect(rows.map(row => row.daemon)).toEqual(['d1']);
    expect(view.container.querySelector('[data-testid="answer"]')?.textContent).toBe('waiting');
    expect(there.paths()).not.toContain('GET /v1/reach');
    await view.unmount();
  });
});
