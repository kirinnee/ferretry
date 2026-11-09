import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import { DEVICE_NOT_ACCEPTED_SENTENCE } from '../../../src/client/sentences.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { pairAgainHref } from '../../../src/router/routes.ts';
import { RelaySessionError } from '../../../src/session/session-client.ts';
import { RELAY_CLOSE_CODES } from '../../../src/session/wire/index.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, mount } from '../../support/dom.ts';
import { CORE, FakeTransport } from '../client/fixtures.ts';

/**
 * C1, as a person meets it: the machine answered `4403`, so this page says so and offers to pair again. Nothing is
 * removed (the proof is in `forget.test.ts`); the page just stops dialling that machine.
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

const surfaces: SurfaceEntry[] = [
  ...CORE,
  {
    id: 'board',
    title: 'Board',
    core: false,
    contract: 'h-board',
    consumes: [],
    manifest: boardManifest,
    app: implementApp(boardManifest, { build: () => ({ screens: { board: () => <p>The board screen</p> } }) }),
  },
];

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

const go = (path: string): void => window.history.replaceState({}, '', path);
afterEach(() => go('/'));

function setup() {
  const transport = new FakeTransport(() => {
    throw new RelaySessionError('unknown device credential', RELAY_CLOSE_CODES.authRejected);
  });
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const runtime = new ShellRuntime({ appVersion: '5.0.0', surfaces, daemons, connect: async () => transport });
  return { runtime, storage };
}

const render = async ({ runtime, storage }: ReturnType<typeof setup>) =>
  await mount(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />,
  );

describe('C1 a machine that answered 4403', () => {
  test('the page says the machine no longer accepts this browser and offers to pair again', async () => {
    go('/d/d1/board');
    const rig = setup();
    const view = await render(rig);
    await settle();
    expect(view.container.querySelector('main')?.textContent).toContain(DEVICE_NOT_ACCEPTED_SENTENCE);
    expect(view.container.textContent).not.toContain('The board screen');
    const pairAgain = view.container.querySelector('[data-device-refused-pair]') as HTMLButtonElement;
    expect(pairAgain.textContent).toBe('Pair again');
    expect(rig.runtime.daemons.get('d1')).toBeDefined();
    await interact(async () => pairAgain.click());
    await settle();
    expect(`${window.location.pathname}${window.location.search}`).toBe(pairAgainHref('d1'));
    await view.unmount();
  });

  test('the pair-again address names the machine and nothing else', () => {
    expect(pairAgainHref('sha256:abc/1')).toBe('/pair?refused=sha256%3Aabc%2F1');
  });

  test('a machine that is fine has no such button', async () => {
    go('/app/');
    const rig = setup();
    const view = await render(rig);
    await settle();
    expect(view.container.querySelector('[data-device-refused-pair]')).toBeNull();
    await view.unmount();
  });
});
