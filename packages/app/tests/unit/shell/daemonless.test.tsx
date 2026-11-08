import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import {
  type DaemonlessPorts,
  type DaemonlessScreenProps,
  provideToShell,
  registeredDaemonless,
} from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, json } from '../client/fixtures.ts';

/**
 * DAEMON-LESS SCREENS: drawn with no daemon and only the ports they are given. The guard (britnee): a daemon-less screen
 * gets NO daemon client — not a default, not the first, not the last used; and a declared daemon-less route never
 * resolves under a `/d/<id>/` prefix.
 */

const manifest = {
  id: 'welcome',
  title: 'Welcome',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  ui: {
    screens: [
      { id: 'landing', path: '/landing/:tab', daemonless: true },
      { id: 'inside', path: 'inside' },
    ],
  },
} as unknown as Manifest;

let seen = undefined as DaemonlessScreenProps | undefined;
const view = (props: DaemonlessScreenProps) => {
  seen = props;
  return <p data-testid="landing">landing {props.params.tab ?? '-'}</p>;
};
const half = provideToShell(
  implementApp(manifest, { build: () => ({ screens: { inside: () => <p data-testid="inside">inside</p> } }) }),
  // `inside` is a per-daemon screen: offering a daemon-less view for it must be ignored.
  { daemonless: () => ({ landing: view, inside: () => <p data-testid="smuggled">no</p> }) },
);
const entry: SurfaceEntry = {
  id: 'welcome',
  title: 'Welcome',
  core: false,
  contract: 'h-welcome',
  consumes: [],
  manifest,
  app: half,
};
const surfaces: SurfaceEntry[] = [...CORE, entry];

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};
const ports = {} as DaemonlessPorts;

function setup(withDaemon: boolean) {
  const transport = new FakeTransport(() => json({ error: 'none', code: 'not_found' }, 404));
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  if (withDaemon) daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const registered = registeredDaemonless(surfaces, ports);
  const runtime = new ShellRuntime({
    appVersion: '5.1.0',
    surfaces,
    daemons,
    connect: async () => transport,
    daemonless: { views: registered.views, location: () => 'https://app.example/landing#secret' },
  });
  return { runtime, storage, transport };
}

const go = (path: string): void => window.history.replaceState({}, '', path);
afterEach(() => go('/'));

async function open(path: string, withDaemon: boolean) {
  go(path);
  const { runtime, storage, transport } = setup(withDaemon);
  const mounted = await mount(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />,
  );
  await settle();
  return { mounted, transport };
}

describe('daemon-less screens', () => {
  test('a declared daemon-less route draws its view with its parameters and no daemon is contacted', async () => {
    seen = undefined;
    const { mounted, transport } = await open('/landing/start', false);
    expect(mounted.container.querySelector('[data-testid="landing"]')?.textContent).toBe('landing start');
    expect(seen?.location()).toBe('https://app.example/landing#secret');
    // With no daemon paired, nothing is dialled for the screen.
    expect(transport.paths()).toEqual([]);
    await mounted.unmount();
  });

  test('guard (a): the props carry no client, and a runtime probe finds none', async () => {
    seen = undefined;
    const { mounted } = await open('/landing/start', true);
    expect(Object.keys(seen ?? {}).toSorted()).toEqual(['location', 'navigate', 'params']);
    const found = (value: unknown, depth = 0): boolean => {
      if (depth > 2 || typeof value !== 'object' || value === null) return false;
      return Object.entries(value).some(
        ([key, inner]) => /client|transport|daemon/iu.test(key) || found(inner, depth + 1),
      );
    };
    expect(found(seen)).toBe(false);
    await mounted.unmount();
  });

  test('guard (b): a daemon-less route never resolves under a /d/<id>/ prefix', async () => {
    const { mounted } = await open('/d/d1/landing/start', true);
    expect(mounted.container.querySelector('[data-testid="landing"]')).toBeNull();
    expect(mounted.container.textContent).toContain('Nothing is here');
    await mounted.unmount();
  });

  test('a view offered for a screen the manifest does not declare daemon-less is ignored', () => {
    const registered = registeredDaemonless(surfaces, ports);
    expect([...registered.views.keys()]).toEqual(['welcome.landing']);
  });

  test('a factory that throws is said, never thrown, and costs only its plugin', () => {
    const broken = provideToShell(implementApp(manifest, { build: () => ({}) }), {
      daemonless: () => {
        throw new Error('no ports');
      },
    });
    const registered = registeredDaemonless([{ ...entry, app: broken }], ports);
    expect(registered.views.size).toBe(0);
    expect(registered.failures).toEqual([{ plugin: 'welcome', reason: 'no ports' }]);
  });

  test('a daemon-less route with no view from its plugin draws the skeleton line', async () => {
    go('/landing/start');
    const storage = memoryStore();
    const runtime = new ShellRuntime({
      appVersion: '5.1.0',
      surfaces,
      daemons: new DaemonList({ storage, now: () => 1 }),
      connect: async () => undefined,
    });
    const mounted = await mount(
      <App
        runtime={runtime}
        themes={new ThemePreferenceStore(storage)}
        layouts={new DeviceLayoutStore(storage)}
        browser={browser}
        scroll={new ScrollMemory(null)}
      />,
    );
    await settle();
    expect(mounted.container.textContent).toContain('Welcome is not built yet');
    await mounted.unmount();
  });
});
