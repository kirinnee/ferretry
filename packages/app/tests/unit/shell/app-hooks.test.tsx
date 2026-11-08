import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest, type PluginClient } from '@ferretry/kernel/manifest';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { provideToShell } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import { useAppHook } from '../../../src/shell/app-hooks.ts';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { mount } from '../../support/dom.ts';
import { render } from '../../../src/testing/react.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * APP PROVIDE HOOKS, end to end through the shell: one plugin's screen OFFERS a hook name and reads it
 * (`useAppHook`); another plugin's half PROVIDES it (`shell.hooks`). The value is built over the provider's own client
 * (the one its views are built with), only once the provider may run on that daemon, and only when exactly one half
 * provides the name.
 */

const manifestOf = (id: string, extra: Partial<Manifest> = {}): Manifest =>
  ({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: ['view'], ...extra }) as unknown as Manifest;

const HOOK = 'offerer.greeting';

/** The offerer: its screen draws what the hook answers, or that there is none. */
const offererManifest = manifestOf('offerer', { ui: { screens: [{ id: 'home', path: 'home' }] } } as Partial<Manifest>);
function Home() {
  const value = useAppHook('d1', HOOK) as { readonly words?: string } | undefined;
  return <p data-testid="hook">{value?.words ?? 'no greeting'}</p>;
}
const offererApp = implementApp(offererManifest, { build: () => ({ screens: { home: Home } }) });

/** A provider whose hook says which daemon it was built for and whether it got its half's own client. */
const providerOf = (id: string, words: string) => {
  const manifest = manifestOf(id, { ui: { panels: [] } } as Partial<Manifest>);
  const clients: PluginClient[] = [];
  const builds: { readonly daemon: string; readonly client: PluginClient }[] = [];
  const app = provideToShell(
    implementApp(manifest, {
      build: ({ client }) => {
        clients.push(client);
        return {};
      },
    }),
    {
      hooks: {
        [HOOK]: ({ client, daemon }) => {
          builds.push({ daemon, client });
          return { words };
        },
      },
    },
  );
  return { manifest, app, clients, builds };
};

const entry = (manifest: Manifest, app: SurfaceEntry['app'], contract: string): SurfaceEntry => ({
  id: manifest.id,
  title: manifest.title,
  core: false,
  contract,
  consumes: [],
  manifest,
  ...(app === undefined ? {} : { app }),
});

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

/** Draws `/d/d1/home` over `surfaces`, with the daemon's contract hashes overridden by `daemonContracts`. */
async function draw(surfaces: readonly SurfaceEntry[], daemonContracts: Record<string, string> = {}) {
  const transport = new FakeTransport((request: TransportRequest) => {
    if (request.path === '/v1/plugins') {
      return json(
        inventoryOf(
          [...surfaces],
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
  const runtime = new ShellRuntime({ appVersion: '5.1.0', surfaces, daemons, connect: async () => transport });
  window.history.replaceState({}, '', '/d/d1/home');
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
  await settle();
  return { view, runtime, said: () => view.container.querySelector('[data-testid="hook"]')?.textContent };
}

afterEach(() => window.history.replaceState({}, '', '/'));

describe('an app hook another half offers', () => {
  test('is the one provider’s value, built over the client its own half is built with, per daemon', async () => {
    const provider = providerOf('provider', 'hello from the provider');
    const surfaces = [
      ...CORE,
      entry(offererManifest, offererApp, 'h-offerer'),
      entry(provider.manifest, provider.app, 'h-provider'),
    ];
    const { view, runtime, said } = await draw(surfaces);

    expect(said()).toBe('hello from the provider');
    expect(provider.builds.map(build => build.daemon)).toEqual(['d1']);
    // The provider's half, built on the same daemon, is handed the very client its hook was built over.
    runtime.half('d1', 'provider');
    expect(provider.clients).toHaveLength(1);
    expect(provider.clients[0]).toBe(provider.builds[0]?.client);
    // Asked again, the same value: a hook is built once per daemon.
    expect(runtime.appHook('d1', HOOK)).toBe(runtime.appHook('d1', HOOK));
    expect(provider.builds).toHaveLength(1);
    await view.unmount();
  });

  test('is nothing when no half provides it', async () => {
    const { view, said } = await draw([...CORE, entry(offererManifest, offererApp, 'h-offerer')]);
    expect(said()).toBe('no greeting');
    await view.unmount();
  });

  test('is nothing when two halves provide it: the offerer never guesses whose value to act on', async () => {
    const one = providerOf('provider', 'one');
    const two = providerOf('second', 'two');
    const { view, said } = await draw([
      ...CORE,
      entry(offererManifest, offererApp, 'h-offerer'),
      entry(one.manifest, one.app, 'h-provider'),
      entry(two.manifest, two.app, 'h-second'),
    ]);
    expect(said()).toBe('no greeting');
    expect([...one.builds, ...two.builds]).toEqual([]);
    await view.unmount();
  });

  test('is nothing while the provider may not run on that daemon, and its factory never runs', async () => {
    const provider = providerOf('provider', 'hello');
    const { view, said } = await draw(
      [...CORE, entry(offererManifest, offererApp, 'h-offerer'), entry(provider.manifest, provider.app, 'h-provider')],
      { provider: 'h-provider-next' },
    );
    expect(said()).toBe('no greeting');
    expect(provider.builds).toEqual([]);
    await view.unmount();
  });

  test('is nothing when the provider’s factory throws', async () => {
    const manifest = manifestOf('provider', { ui: { panels: [] } } as Partial<Manifest>);
    const broken = provideToShell(implementApp(manifest, { build: () => ({}) }), {
      hooks: {
        [HOOK]: () => {
          throw new Error('no store here');
        },
      },
    });
    const { view, said } = await draw([
      ...CORE,
      entry(offererManifest, offererApp, 'h-offerer'),
      entry(manifest, broken, 'h-provider'),
    ]);
    expect(said()).toBe('no greeting');
    await view.unmount();
  });

  test('is nothing outside a shell', () => {
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useAppHook('d1', HOOK));
      return null;
    }
    render(<Probe />);
    expect(seen).toEqual([undefined]);
  });
});
