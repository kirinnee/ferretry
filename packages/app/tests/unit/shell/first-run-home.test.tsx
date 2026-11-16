import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import { provideToShell, registeredDaemonless } from '../../../src/connect/provides.ts';
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
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * S14: with no paired daemon the home page sends the person to Onboarding's daemon-less `/onboarding` screen (replacing
 * the entry); a paired device never goes; and with no Onboarding installed the old sentence stays.
 */

const onboardingManifest = {
  id: 'onboarding',
  title: 'Onboarding',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  ui: { screens: [{ id: 'onboarding', path: '/onboarding', daemonless: true }] },
} as unknown as Manifest;
const onboardingApp = provideToShell(implementApp(onboardingManifest, { build: () => ({}) }), {
  daemonless: () => ({ onboarding: () => <p data-testid="first-run">First run</p> }),
});

const entry = (manifest: Manifest, app: SurfaceEntry['app']): SurfaceEntry => ({
  id: manifest.id,
  title: manifest.title,
  core: false,
  contract: `h-${manifest.id}`,
  consumes: [],
  manifest,
  ...(app === undefined ? {} : { app }),
});

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

function setup(options: { paired: boolean; withOnboarding: boolean }) {
  const surfaces: SurfaceEntry[] = [
    ...CORE,
    ...(options.withOnboarding ? [entry(onboardingManifest, onboardingApp)] : []),
  ];
  const transport = new FakeTransport(request => {
    if (request.path === '/v1/plugins') return json(inventoryOf(surfaces));
    return json({ protocol: 1, version: '5.0.0' });
  });
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  if (options.paired)
    daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const registered = registeredDaemonless(surfaces, {} as never);
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons,
    connect: async () => transport,
    daemonless: { views: registered.views, location: () => '' },
  });
  return (
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />
  );
}

const go = (path: string): void => window.history.replaceState({}, '', path);
afterEach(() => go('/'));

describe('S14 first run', () => {
  test('S14 no daemon sends home to /onboarding, replacing the entry', async () => {
    go('/app/');
    const before = window.history.length;
    const view = await mount(setup({ paired: false, withOnboarding: true }));
    await settle();
    expect(window.location.pathname).toBe('/onboarding');
    expect(view.container.querySelector('[data-testid="first-run"]')).not.toBeNull();
    expect(window.history.length).toBe(before);
    await view.unmount();
  });

  test('S14 a paired device never goes to /onboarding', async () => {
    go('/app/');
    const view = await mount(setup({ paired: true, withOnboarding: true }));
    await settle();
    expect(window.location.pathname).toBe('/app/');
    expect(view.container.querySelector('[data-testid="first-run"]')).toBeNull();
    expect(view.container.textContent).toContain('laptop');
    await view.unmount();
  });

  test('S14 with no Onboarding installed the home keeps its sentence and goes nowhere', async () => {
    go('/app/');
    const view = await mount(setup({ paired: false, withOnboarding: false }));
    await settle();
    expect(window.location.pathname).toBe('/app/');
    expect(view.container.textContent).toContain('No daemons yet');
    await view.unmount();
  });
});
