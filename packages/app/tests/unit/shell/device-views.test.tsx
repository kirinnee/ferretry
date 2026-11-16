import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import { lazy, type ReactNode, useEffect, useState } from 'react';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { type DaemonlessPorts, provideToShell, registeredDaemonless } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import { useAppHook } from '../../../src/shell/app-hooks.ts';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { useEveryDaemon } from '../../../src/shell/every-daemon.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { useFragment } from '../../../src/shell/use-fragment.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, type Mounted, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * THE DEVICE-VIEW HOST AND THE ONE TAKER (shell contract S3, MA2): each plugin's device view is mounted once at the frame
 * root, with no daemon, under `WithoutShell`, inside its identity; it is the only taker of its keyed fragment (a
 * per-daemon view of the same plugin gets nothing), it lists machines through `useEveryDaemon`, and a throw costs only
 * that view. A declared fragment has left the address before the first render and before any chunk is asked for.
 */

const LINK = '#deep/A3?session=s-1&machine=d2';
const HOOK = 'deep.store';

const manifestOf = (id: string, ui: Record<string, unknown>): Manifest =>
  ({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: ['view'], ui }) as unknown as Manifest;

interface Seen {
  mounts: number;
  machines: number[];
  taken: (string | undefined)[];
  arrivals: number[];
  hookInDevice: unknown[];
  screenFragment: { arrival: number; taken: string | undefined }[];
  hashAtChunk: string[];
  hashAtFirstDraw: string[];
  landTaken: (string | undefined)[];
}
const seen: Seen = {
  mounts: 0,
  machines: [],
  taken: [],
  arrivals: [],
  hookInDevice: [],
  screenFragment: [],
  hashAtChunk: [],
  hashAtFirstDraw: [],
  landTaken: [],
};
const reset = (): void => {
  seen.mounts = 0;
  for (const key of Object.keys(seen) as (keyof Seen)[])
    if (Array.isArray(seen[key])) (seen[key] as unknown[]).length = 0;
};

function Watcher(): ReactNode {
  const rows = useEveryDaemon();
  const { arrival, take } = useFragment('deep');
  seen.hookInDevice.push(useAppHook('d1', HOOK));
  useEffect(() => {
    seen.mounts += 1;
  }, []);
  useEffect(() => {
    seen.machines.push(rows.length);
  }, [rows]);
  useEffect(() => {
    if (arrival === 0) return;
    seen.arrivals.push(arrival);
    seen.taken.push(take());
  }, [arrival, take]);
  return null;
}

function Screen(): ReactNode {
  const fragment = useFragment('deep');
  useEffect(() => {
    seen.screenFragment.push({ arrival: fragment.arrival, taken: fragment.take() });
  }, [fragment]);
  return <p data-testid="screen">screen</p>;
}

const deepManifest = manifestOf('deep', { screens: [{ id: 'main', path: 'main' }] });
const deep: SurfaceEntry = {
  id: 'deep',
  title: 'Deep',
  core: false,
  contract: 'h-deep',
  consumes: [],
  manifest: deepManifest,
  app: provideToShell(implementApp(deepManifest, { build: () => ({ screens: { main: Screen } }) }), {
    fragments: [{ form: 'keyed', key: 'deep' }],
    device: { watch: Watcher },
    hooks: { [HOOK]: () => ({ store: true }) },
  }),
};

const brokenManifest = manifestOf('broken', { screens: [] });
const broken: SurfaceEntry = {
  id: 'broken',
  title: 'Broken',
  core: false,
  contract: 'h-broken',
  consumes: [],
  manifest: brokenManifest,
  app: provideToShell(implementApp(brokenManifest, { build: () => ({}) }), {
    device: {
      boom: () => {
        throw new Error('device view failed');
      },
    },
  }),
};

/** A daemon-less screen whose view is a lazy chunk: it records the address when the chunk is asked for and drawn. */
function Land(): ReactNode {
  const [first] = useState(() => window.location.hash);
  seen.hashAtFirstDraw.push(first);
  const { arrival, take } = useFragment('land');
  useEffect(() => {
    if (arrival > 0) seen.landTaken.push(take());
  }, [arrival, take]);
  return <p data-testid="land">{arrival > 0 ? 'Opening link…' : 'no link'}</p>;
}
const LazyLand = lazy(async () => {
  seen.hashAtChunk.push(window.location.hash);
  return { default: Land };
});
const landerManifest = manifestOf('lander', { screens: [{ id: 'land', path: '/land', daemonless: true }] });
const lander: SurfaceEntry = {
  id: 'lander',
  title: 'Lander',
  core: false,
  contract: 'h-lander',
  consumes: [],
  manifest: landerManifest,
  app: provideToShell(implementApp(landerManifest, { build: () => ({}) }), {
    fragments: [{ form: 'path', screen: 'land' }],
    daemonless: () => ({ land: () => <LazyLand /> }),
  }),
};

const surfaces: SurfaceEntry[] = [...CORE, deep, broken, lander];

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

/** The `hashchange` listeners each boot armed, removed after its test so no stale taker hears the next one. */
const armed: (() => void)[] = [];
const address = {
  location: window.location,
  history: window.history,
  addEventListener: (type: 'hashchange', listener: () => void) => {
    armed.push(listener);
    window.addEventListener(type, listener);
  },
};
const quiet = console.error;
let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const listener of armed.splice(0)) window.removeEventListener('hashchange', listener);
  window.history.replaceState(null, '', '/');
  console.error = quiet;
  reset();
});

async function boot(path: string, machines: readonly string[]) {
  // The broken device view's throw is React's to report; it is contained, which is what is under test.
  console.error = () => {};
  window.history.replaceState(null, '', path);
  const list = new DaemonList({ storage: memoryStore(), now: () => 1 });
  for (const id of machines)
    list.add({ daemon: id, machine: `${id}-host`, deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const transport = new FakeTransport((request: TransportRequest) => {
    if (request.path === '/v1/plugins') return json(inventoryOf(surfaces, {}));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    return json({ capabilities: [] });
  });
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons: list,
    connect: async () => transport,
    daemonless: {
      views: registeredDaemonless(surfaces, {} as DaemonlessPorts).views,
      location: () => window.location.href,
    },
    address,
  });
  const storage = memoryStore();
  view = await mount(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />,
  );
  await settle();
  return { runtime, view };
}

describe('the device-view host', () => {
  for (const machines of [[], ['d1'], ['d1', 'd2']] as const) {
    test(`mounts each device view once with ${machines.length} machine(s), and a throw costs only its own view`, async () => {
      const { view } = await boot('/app/', machines);
      expect(seen.mounts).toBe(1);
      expect(seen.machines.at(-1)).toBe(machines.length);
      expect(view.container.textContent).toContain('Broken stopped working on this screen.');
    });
  }

  test('a device view is drawn under WithoutShell: useAppHook answers undefined there (m6)', async () => {
    await boot('/app/', ['d1']);
    expect(seen.hookInDevice.length).toBeGreaterThan(0);
    expect(seen.hookInDevice.every(value => value === undefined)).toBe(true);
  });
});

describe('the one taker of a keyed fragment', () => {
  test('two machines, two halves: the link is taken once, by the device view, and is gone from the address', async () => {
    window.history.replaceState(null, '', '/d/d1/main');
    await boot(`/d/d1/main${LINK}`, ['d1', 'd2']);
    expect(window.location.hash).toBe('');
    expect(seen.taken).toEqual([LINK]);
    // The per-daemon screen of the same plugin gets nothing.
    expect(seen.screenFragment.length).toBeGreaterThan(0);
    expect(seen.screenFragment.every(read => read.arrival === 0 && read.taken === undefined)).toBe(true);
  });

  test('a second link on the open page arrives again (hashchange) and is taken again', async () => {
    await boot(`/app/${LINK}`, ['d1']);
    await interact(() => {
      window.history.replaceState(null, '', '/app/#deep/A4');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await settle();
    expect(seen.taken).toEqual([LINK, '#deep/A4']);
    expect(seen.arrivals).toEqual([1, 2]);
    expect(window.location.hash).toBe('');
  });

  test('the router’s own navigation to an address with a declared fragment is read before that page draws', async () => {
    const { runtime } = await boot('/app/', ['d1']);
    // A navigation through the router's history write (what a plugin's own link does).
    window.history.pushState(null, '', `/app/${LINK}`);
    await interact(() => runtime.addressChanged());
    await settle();
    expect(window.location.hash).toBe('');
    expect(seen.taken).toEqual([LINK]);
  });
});

describe('a path fragment', () => {
  test('has left the address before the first render and before the lazy chunk is asked for', async () => {
    const { view } = await boot('/land#v1.secret-code', []);
    expect(seen.hashAtChunk).toEqual(['']);
    expect(seen.hashAtFirstDraw[0]).toBe('');
    expect(seen.landTaken).toEqual(['#v1.secret-code']);
    expect(window.location.href).not.toContain('secret-code');
    expect(JSON.stringify(window.history.state)).not.toContain('secret-code');
    // The first draw says the link is opening; the code itself is never a render value.
    expect(view.container.textContent).not.toContain('secret-code');
  });

  test('the daemon-less screen’s location no longer carries the stripped code', async () => {
    const { runtime } = await boot('/land#v1.secret-code', []);
    expect(runtime.location()).not.toContain('secret-code');
  });
});
