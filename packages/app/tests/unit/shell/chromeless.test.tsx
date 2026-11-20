import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import { type DaemonlessPorts, provideToShell, registeredDaemonless } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import type { PasskeyHandler, PasskeyProvision } from '../../../src/passkey/passkey.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { drawerState } from '../../../src/shell/drawer-state.ts';
import { APP_STORAGE } from '../../../src/storage/names.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, mount, pressKey } from '../../support/dom.ts';
import { CORE, FakeTransport, json } from '../client/fixtures.ts';

/**
 * CHROME-LESS SCREENS (r10 O2): a screen that declares `chrome: 'none'` is drawn without the drawer, the bottom nav, the
 * side column, the phone title bar and the command bar — the shell's frame holds only the page, the status strip (a
 * view's banners) and the one passkey prompt. A screen that says nothing is unchanged.
 */

const manifest = {
  id: 'setup',
  title: 'Setup',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  ui: {
    screens: [
      { id: 'flow', path: '/flow', daemonless: true, chrome: 'none' },
      { id: 'plain', path: '/plain', daemonless: true },
    ],
  },
} as unknown as Manifest;

const half = provideToShell(implementApp(manifest, { build: () => ({}) }), {
  daemonless: () => ({
    flow: () => <p data-testid="flow">the flow</p>,
    plain: () => <p data-testid="plain">a plain page</p>,
  }),
});
const entry: SurfaceEntry = {
  id: 'setup',
  title: 'Setup',
  core: false,
  contract: 'h-setup',
  consumes: [],
  manifest,
  app: half,
};
const surfaces: SurfaceEntry[] = [...CORE, entry];

const wide: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};
const phone: ShellWindow = {
  matchMedia: query => ({
    matches: query.includes('max-width'),
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
  document: { documentElement: document.documentElement },
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

// The prompt layer stands in for Access's: a marker is all the test needs to see that the frame still mounts it.
const handler = {
  need: () => undefined,
  confirm: async () => false,
  ask: async () => false,
  focus: () => {},
  locked: () => [],
  subscribe: () => () => {},
} as unknown as PasskeyHandler;
const provision = { handler, Prompts: () => <div data-testid="passkey-prompts" /> } as unknown as PasskeyProvision;

const go = (path: string): void => window.history.replaceState({}, '', path);
afterEach(() => {
  go('/');
  drawerState.forget();
});

async function open(path: string, viewport: 'wide' | 'phone') {
  go(path);
  drawerState.forget();
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  const transport = new FakeTransport(() => json({ error: 'none', code: 'not_found' }, 404));
  const runtime = new ShellRuntime({
    appVersion: '5.1.0',
    surfaces,
    daemons,
    connect: async () => transport,
    passkey: () => provision,
    daemonless: {
      views: registeredDaemonless(surfaces, {} as DaemonlessPorts).views,
      location: () => 'https://app.example/flow',
    },
  });
  const mounted = await mount(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={viewport === 'phone' ? phone : wide}
      scroll={new ScrollMemory(null)}
    />,
  );
  await settle();
  return mounted;
}

const CHROME = '.fy-drawer, .fy-drawer-scrim, [data-slot="drawer"], .fy-nav, .fy-side, [data-slot="phone-title"]';
const commandBar = () => document.querySelector('[role="dialog"][aria-label="Command bar"]');

describe('chrome-less screens', () => {
  test('wide: the page is drawn with no drawer, nav, side column or title bar, and Ctrl-K opens no command bar', async () => {
    const mounted = await open('/flow', 'wide');
    const root = mounted.container;
    expect(root.querySelector('[data-testid="flow"]')?.textContent).toBe('the flow');
    expect(root.querySelector(CHROME)).toBeNull();
    expect(root.querySelector('nav')).toBeNull();
    expect(root.querySelector('.fy-frame')?.getAttribute('data-chrome')).toBe('none');
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));
    await settle();
    expect(commandBar()).toBeNull();
    await mounted.unmount();
  });

  test('phone: no bottom bar, no title bar, no menu button, and Escape does not open the drawer', async () => {
    const mounted = await open('/flow', 'phone');
    const root = mounted.container;
    expect(root.querySelector('[data-testid="flow"]')).not.toBeNull();
    expect(root.querySelector(`${CHROME}, [data-slot="bottom"], .fy-nav--bottom, [data-drawer-toggle]`)).toBeNull();
    expect(root.querySelector('.fy-frame--nav-bottom')).toBeNull();
    await interact(() => pressKey(document.body, 'Escape'));
    await settle();
    expect(root.querySelector('.fy-drawer, .fy-drawer-scrim')).toBeNull();
    await mounted.unmount();
  });

  test('the passkey prompt layer and the status strip are still mounted', async () => {
    const mounted = await open('/flow', 'wide');
    expect(document.querySelector('[data-testid="passkey-prompts"]')).not.toBeNull();
    expect(mounted.container.querySelector('.fy-status[data-slot="status"]')).not.toBeNull();
    await mounted.unmount();
  });

  test('an ordinary screen is unchanged: the drawer and the command bar are there', async () => {
    const mounted = await open('/plain', 'wide');
    const root = mounted.container;
    expect(root.querySelector('[data-testid="plain"]')).not.toBeNull();
    expect(root.querySelector('.fy-drawer')).not.toBeNull();
    expect(root.querySelector('.fy-frame')?.hasAttribute('data-chrome')).toBe(false);
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));
    await settle();
    expect(commandBar()).not.toBeNull();
    await mounted.unmount();
  });

  test('Ctrl-K pressed on a chrome-less screen does not leave the command bar waiting for the next screen', async () => {
    const mounted = await open('/flow', 'wide');
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));
    await settle();
    await interact(() => window.history.pushState({}, '', '/plain'));
    await interact(() => window.dispatchEvent(new PopStateEvent('popstate')));
    await settle();
    expect(mounted.container.querySelector('[data-testid="plain"]')).not.toBeNull();
    expect(commandBar()).toBeNull();
    await mounted.unmount();
  });

  // e-cmdb: Cmd/Ctrl+B has no drawer to toggle on a chrome-less screen and must never write the remembered rail setting.
  test('Ctrl-B on a chrome-less screen draws no drawer and leaves the remembered rail setting alone (wide and phone)', async () => {
    for (const viewport of ['wide', 'phone'] as const) {
      const mounted = await open('/flow', viewport);
      await interact(() => pressKey(document.body, 'b', { ctrlKey: true }));
      await interact(() => pressKey(document.body, 'b', { metaKey: true }));
      await settle();
      expect(mounted.container.querySelector(CHROME)).toBeNull();
      expect(drawerState.open()).toBe(false);
      expect(drawerState.collapsed()).toBeUndefined();
      expect(window.localStorage.getItem(APP_STORAGE.drawer)).toBeNull();
      await mounted.unmount();
    }
  });

  test('Ctrl-B still toggles the drawer on an ordinary screen', async () => {
    const mounted = await open('/plain', 'wide');
    const before = mounted.container.querySelector('.fy-drawer--rail') !== null;
    await interact(() => pressKey(document.body, 'b', { ctrlKey: true }));
    await settle();
    expect(mounted.container.querySelector('.fy-drawer--rail') !== null).toBe(!before);
    expect(window.localStorage.getItem(APP_STORAGE.drawer)).not.toBeNull();
    await mounted.unmount();
  });
});
