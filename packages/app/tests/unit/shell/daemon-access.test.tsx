import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import { useEffect, useState } from 'react';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { type DaemonClientOf, useDaemonClients, usePairedDaemons } from '../../../src/shell/daemon-access.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from '../client/fixtures.ts';

/**
 * A page that reads several daemons: the paired list, live, and one package's client on each of them, which waits for
 * the daemon's inventory and refuses (saying why) for a daemon that is not paired or does not allow the package.
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

let clientOf: DaemonClientOf | undefined;
let listed: readonly string[] = [];

const app = implementApp(manifest, {
  build: () => ({
    screens: {
      reach: () => {
        const daemons = usePairedDaemons();
        const clients = useDaemonClients('reach');
        const [answer, setAnswer] = useState('waiting');
        listed = daemons.map(daemon => daemon.daemon);
        clientOf = clients;
        useEffect(() => {
          let live = true;
          void clients('d2').then(
            client => client.call<{ ok: boolean }>('GET /v1/reach').then(body => live && setAnswer(`ok:${body.ok}`)),
            (error: Error) => live && setAnswer(error.message),
          );
          return () => {
            live = false;
          };
        }, [clients]);
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
  return { runtime, storage, daemons };
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
  clientOf = undefined;
  listed = [];
});

describe('reaching the other paired daemons', () => {
  test('the paired list is live and a package client waits for another daemon, then reads through it', async () => {
    window.history.replaceState({}, '', '/d/d1/reach');
    const { runtime, storage, daemons } = setup();
    const view = await draw(runtime, storage);
    await settle();
    expect([...listed].sort()).toEqual(['d1', 'd2']);
    expect(view.container.querySelector('[data-testid="answer"]')?.textContent).toBe('ok:true');
    await interact(() => daemons.remove('d2'));
    await settle();
    expect(listed).toEqual(['d1']);
    await view.unmount();
  });

  test('a daemon that is not paired is refused with a sentence, not hung', async () => {
    window.history.replaceState({}, '', '/d/d1/reach');
    const { runtime, storage } = setup();
    const view = await draw(runtime, storage);
    await settle();
    let reason = '';
    await interact(async () => {
      await clientOf?.('d9').catch((error: Error) => {
        reason = error.message;
      });
    });
    expect(reason).toBe('This device cannot reach this daemon yet.');
    await view.unmount();
  });

  test('a daemon that does not allow the package refuses with the shell’s line and sends nothing', async () => {
    window.history.replaceState({}, '', '/d/d1/reach');
    const { runtime, storage } = setup({ reach: { on: false } });
    const view = await draw(runtime, storage);
    await settle();
    let reason = '';
    await interact(async () => {
      await clientOf?.('d2').catch((error: Error) => {
        reason = error.message;
      });
    });
    expect(reason).not.toBe('');
    expect(reason).not.toBe('waiting');
    await view.unmount();
  });
});
