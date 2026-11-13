import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
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
import { usePairedDaemons } from '../../../src/shell/daemon-access.ts';
import { useEveryDaemon } from '../../../src/shell/every-daemon.ts';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { PanelSlot, ScreenView } from '../../../src/shell/views.tsx';
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
    panels: [{ id: 'note', slot: 'daemon.status' }],
  },
} as unknown as Manifest;

const got: { props?: DaemonlessScreenProps; reach?: readonly unknown[] | undefined } = {};
const current = (): DaemonlessScreenProps | undefined => got.props;
const reached = (): readonly unknown[] | undefined => got.reach;
/** What a daemon-less view could try with the shell's own hooks and components, given a daemon id it learned elsewhere. */
function Reaching(): ReactNode {
  got.reach = useEveryDaemon();
  return (
    <>
      <span data-testid="paired">{usePairedDaemons().length}</span>
      <PanelSlot daemon="d1" slot="daemon.status" />
    </>
  );
}
const view = (props: DaemonlessScreenProps) => {
  got.props = props;
  return (
    <div>
      <p data-testid="landing">landing {props.params.tab ?? '-'}</p>
      <Reaching />
    </div>
  );
};
const half = provideToShell(
  implementApp(manifest, {
    build: () => ({
      screens: { inside: () => <p data-testid="inside">inside</p> },
      panels: { note: () => <p data-testid="note">note</p> },
    }),
  }),
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

// A failed or refused plugin-list read is asked again on a timer, so every paired daemon is unpaired after its test
// (unmounting the view does not stop the runtime): a timer left running fires inside a later test in the same process.
const openedLists: DaemonList[] = [];
afterEach(() => {
  for (const daemons of openedLists.splice(0)) daemons.remove('d1');
});

function setup(withDaemon: boolean) {
  const transport = new FakeTransport(() => json({ error: 'none', code: 'not_found' }, 404));
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  if (withDaemon) openedLists.push(daemons);
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
    delete got.props;
    const { mounted, transport } = await open('/landing/start', false);
    expect(mounted.container.querySelector('[data-testid="landing"]')?.textContent).toBe('landing start');
    expect(current()?.location()).toBe('https://app.example/landing#secret');
    // With no daemon paired, nothing is dialled for the screen.
    expect(transport.paths()).toEqual([]);
    await mounted.unmount();
  });

  test('guard (a): the props carry no client, and a runtime probe finds none', async () => {
    delete got.props;
    const { mounted } = await open('/landing/start', true);
    // `chooseDaemon` (S10) is the one door to a machine, and it opens only on the person's click.
    expect(Object.keys(current() ?? {}).toSorted()).toEqual(['chooseDaemon', 'location', 'navigate', 'params']);
    const found = (value: unknown, depth = 0): boolean => {
      if (depth > 2 || typeof value !== 'object' || value === null) return false;
      return Object.entries(value).some(
        ([key, inner]) => /client|transport|daemon/iu.test(key) || found(inner, depth + 1),
      );
    };
    const { chooseDaemon: _door, ...rest } = current() as DaemonlessScreenProps;
    expect(found(rest)).toBe(false);
    await mounted.unmount();
  });

  test('guard (a): no hook or component of the shell reaches a paired daemon from a daemon-less view, by a daemon id it knows', async () => {
    delete got.props;
    got.reach = undefined;
    const { mounted, transport } = await open('/landing/start', true);
    // The paired daemon exists and its id is known (a real screen would read it from the list); the view still has no reach.
    await settle();
    // The shell itself keeps its selected daemon's connection; the view adds nothing to it.
    const before = transport.paths();
    expect(reached()).toEqual([]);
    await settle();
    expect(transport.paths()).toEqual(before);
    // A panel slot drawn inside it places nothing, and the paired list reads as empty there.
    expect(
      mounted.container
        .querySelector('[data-testid="landing"]')
        ?.parentElement?.querySelector('[data-slot="daemon.status"]'),
    ).toBeNull();
    expect(mounted.container.querySelector('[data-testid="note"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="paired"]')?.textContent).toBe('0');
    await mounted.unmount();
  });

  test('guard (b): a daemon-less route never resolves under a /d/<id>/ prefix', async () => {
    const { mounted } = await open('/d/d1/landing/start', true);
    expect(mounted.container.querySelector('[data-testid="landing"]')).toBeNull();
    expect(mounted.container.textContent).toContain('Nothing is here');
    await mounted.unmount();
  });

  test('ScreenView itself draws a daemon-less screen under a daemon as the skeleton line, never its view', async () => {
    const screen = { plugin: 'welcome', id: 'landing', path: '/landing/:tab', label: 'Landing' };
    delete got.props;
    // No provider at all: the defence-in-depth branch must answer before anything reads the shell.
    const mounted = await mount(<ScreenView daemon="d1" screen={screen} params={{ tab: 'start' }} />);
    expect(mounted.container.textContent).toContain('Not in 5.0 yet: Landing');
    expect(got.props).toBeUndefined();
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
    expect(mounted.container.textContent).toContain('Not in 5.0 yet: Welcome');
    await mounted.unmount();
  });
});
