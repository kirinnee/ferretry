import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import { useEffect, useState } from 'react';
import { type PasskeyHostPorts, provideToShell, registeredPasskey } from '../../../src/connect/provides.ts';
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import type { PasskeyHandler, PasskeyNeed, PasskeyProvision, PromptOrigin } from '../../../src/passkey/passkey.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * A555 r7: A PAGE WHOSE READ WAS REFUSED FOR A PASSKEY NOBODY ASKED FOR GETS ONE PRESS, NEVER A MODAL OR A DEAD END.
 *
 * After a reload or a deep link nobody is acting on the page, so its first read raises no prompt. The shell then draws
 * one line with one button for the machine the route names; pressing it opens the one prompt as the person's own, and
 * once confirmed the page is built again and reads again.
 */

const boardManifest = {
  id: 'board',
  title: 'Board',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  actions: { routes: [{ key: 'GET /v1/board', minimum: 'authenticated', caller: 'any', audit: 'skip' }] },
  ui: { screens: [{ id: 'board', path: 'board', nav: { label: 'Board', order: 1 } }] },
} as unknown as Manifest;

/** A page that reads once on mount and draws what it got: a page with no "Confirm it's you" of its own. */
const boardApp = implementApp(boardManifest, {
  build: ({ client }) => ({
    screens: {
      board: function Board() {
        const [said, setSaid] = useState('reading');
        useEffect(() => {
          void client.call('GET /v1/board').then(
            () => setSaid('the cards'),
            (refused: unknown) => setSaid((refused as { code?: string }).code ?? 'failed'),
          );
        }, []);
        return <p data-testid="board">{said}</p>;
      },
    },
  }),
});

const accessManifest = {
  id: 'access',
  title: 'Access',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
} as unknown as Manifest;

const STEP_UP = json({ error: 'Confirm with a passkey.', code: 'grant_step_up_required' }, 403);
const UNLOCK = json({ error: 'Unlock this machine first.', code: 'unlock_required' }, 401);

function provision() {
  const asked: { need: PasskeyNeed; origin: PromptOrigin }[] = [];
  const parked: ((confirmed: boolean) => void)[] = [];
  const handler: PasskeyHandler = {
    need: refusal => {
      const code = (refusal.body as { code?: string } | null)?.code;
      if (refusal.status === 401 && code === 'unlock_required') return { kind: 'unlock' };
      if (refusal.status === 403 && code === 'grant_step_up_required') return { kind: 'step-up' };
      return undefined;
    },
    confirm: async (_daemon, need, origin) => {
      asked.push({ need, origin });
      // As Access's gate: a read nobody caused waits, silently, for a person's press to confirm.
      if (origin === 'unasked') return await new Promise<boolean>(resolve => parked.push(resolve));
      for (const release of parked.splice(0)) release(true);
      return true;
    },
    ask: async () => true,
    focus: () => {},
    locked: () => [],
    subscribe: () => () => {},
  };
  const made: PasskeyProvision = { handler, Prompts: () => <div data-testid="access-prompts" /> };
  return { made, asked };
}

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
  for (let i = 0; i < 12; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

function setup(made: PasskeyProvision, refusal: TransportAnswer) {
  const accessApp = provideToShell(implementApp(accessManifest, { build: () => ({}) }), { passkey: () => made });
  const surfaces: SurfaceEntry[] = [...CORE, entry(boardManifest, boardApp), entry(accessManifest, accessApp)];
  let confirmed = false;
  const transport = new FakeTransport((request: TransportRequest) => {
    if (request.path === '/v1/plugins') return json(inventoryOf(surfaces));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    if (request.path === '/v1/board') return confirmed ? json({ cards: [] }) : refusal;
    return json({ error: 'none', code: 'not_found' }, 404);
  });
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const ports: PasskeyHostPorts = {
    clientOf: () => undefined,
    daemons,
    origin: 'https://app.example',
    credentials: { create: async () => null, get: async () => null },
  };
  const registered = registeredPasskey(surfaces, ports);
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons,
    connect: async () => transport,
    passkey: () => registered.passkey,
  });
  const app = (
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />
  );
  return { app, transport, confirm: () => (confirmed = true) };
}

const go = (path: string): void => window.history.replaceState({}, '', path);
afterEach(() => go('/'));

const bar = () => document.body.querySelector<HTMLElement>('[data-passkey-bar]');
const page = () => document.body.querySelector('[data-testid="board"]')?.textContent;

describe('A555 r7 one press for a passkey nobody asked for', () => {
  for (const [kind, refusal, words, button] of [
    ['step-up', STEP_UP, 'confirm it’s you', 'Confirm it’s you'],
    ['unlock', UNLOCK, 'locked', 'Unlock'],
  ] as const)
    test(`${kind}: a page loaded with nobody acting raises NO prompt, the shell offers one press, and the page reads again`, async () => {
      go('/d/d1/board');
      const { made, asked } = provision();
      const { app, transport, confirm } = setup(made, refusal);
      const view = await mount(app);
      await settle();
      // No prompt was shown for a read nobody caused: a step-up's refusal is the page's answer, an unlock's read waits
      // (silently, `unasked`); either way the shell offers the press.
      expect(asked.filter(entry => entry.origin !== 'unasked')).toEqual([]);
      expect(page()).toBe(refusal === STEP_UP ? 'grant_step_up_required' : 'reading');
      expect(bar()?.dataset.passkeyBar).toBe(kind);
      expect(bar()?.textContent?.toLowerCase()).toContain(words);
      const press = bar()?.querySelector<HTMLButtonElement>('[data-passkey-bar-press]');
      expect(press?.textContent).toBe(button);
      confirm();
      await interact(() => press?.click());
      await settle();
      // The press is the person's: the ONE prompt was asked as theirs, and the page was built again and read again.
      expect(asked.filter(entry => entry.origin === 'explicit')).toEqual([{ need: { kind }, origin: 'explicit' }]);
      expect(page()).toBe('the cards');
      expect(bar()).toBeNull();
      expect(transport.paths().filter(path => path === 'GET /v1/board').length).toBeGreaterThanOrEqual(2);
      await view.unmount();
    });

  test('no bar while nothing was refused', async () => {
    go('/d/d1/board');
    const { made } = provision();
    const { app } = setup(made, json({ cards: [] }));
    const view = await mount(app);
    await settle();
    expect(page()).toBe('the cards');
    expect(bar()).toBeNull();
    await view.unmount();
  });
});
