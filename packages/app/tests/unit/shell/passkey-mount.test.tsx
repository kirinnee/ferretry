import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest, type PluginClient } from '@ferretry/kernel/manifest';
import { type PasskeyHostPorts, provideToShell, registeredPasskey } from '../../../src/connect/provides.ts';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import type { PasskeyHandler, PasskeyNeed, PasskeyPorts, PasskeyProvision } from '../../../src/passkey/passkey.ts';
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
 * THE MOUNT (G95, G105): the shell places Access's prompts once, where every page is drawn, tells them the machine on
 * screen, and hands every daemon client the one handler — so a plugin that knows nothing of passkeys still has its
 * refusal asked about and its call sent again once.
 */

const boardManifest = {
  id: 'board',
  title: 'Board',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  actions: { routes: [{ key: 'POST /v1/board', minimum: 'authenticated', caller: 'any', audit: 'skip' }] },
  ui: { screens: [{ id: 'board', path: 'board', nav: { label: 'Board', order: 1 } }] },
} as unknown as Manifest;

let boardClient: PluginClient | undefined;
const boardApp = implementApp(boardManifest, {
  build: ({ client }) => {
    boardClient = client;
    return { screens: { board: () => <p data-testid="board">The board screen</p> } };
  },
});

const accessManifest = {
  id: 'access',
  title: 'Access',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
} as unknown as Manifest;
const intruderManifest = { ...accessManifest, id: 'intruder', title: 'Intruder' } as unknown as Manifest;

/** A passkey provision that records the machine it is told is on screen and answers every prompt yes. */
function provision() {
  const focused: (string | null)[] = [];
  const asked: PasskeyNeed[] = [];
  const handler: PasskeyHandler = {
    need: refusal =>
      refusal.status === 403 && (refusal.body as { code?: string }).code === 'grant_step_up_required'
        ? { kind: 'step-up' }
        : undefined,
    confirm: async (_daemon, need) => {
      asked.push(need);
      return true;
    },
    ask: async () => true,
    focus: daemon => {
      focused.push(daemon);
    },
    locked: () => [],
    subscribe: () => () => {},
  };
  const made: PasskeyProvision = { handler, Prompts: () => <div data-testid="access-prompts">Access prompts</div> };
  return { made, focused, asked };
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
  for (let i = 0; i < 10; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

function setup(made: PasskeyProvision | undefined) {
  const accessApp = provideToShell(implementApp(accessManifest, { build: () => ({}) }), {
    ...(made === undefined ? {} : { passkey: () => made }),
  });
  const surfaces: SurfaceEntry[] = [...CORE, entry(boardManifest, boardApp), entry(accessManifest, accessApp)];
  let boardAnswers = 0;
  const transport = new FakeTransport((request: TransportRequest) => {
    if (request.path === '/v1/plugins') return json(inventoryOf(surfaces));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    if (request.path === '/v1/board') {
      boardAnswers += 1;
      return boardAnswers === 1
        ? json({ error: 'Confirm with a passkey.', code: 'grant_step_up_required' }, 403)
        : json({ ok: true });
    }
    return json({ error: 'none', code: 'not_found' }, 404);
  });
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  daemons.add({ daemon: 'd2', machine: 'desk', deviceId: 'dev', address: 'http://127.0.0.1:40246' });
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
  return { runtime, daemons, transport, app };
}

const go = (path: string): void => window.history.replaceState({}, '', path);
afterEach(() => go('/'));

describe('G105 the one passkey prompt is mounted by the shell', () => {
  test('G105 Access’s prompts are drawn once over a plugin’s page', async () => {
    go('/d/d1/board');
    const { made } = provision();
    const { app } = setup(made);
    const view = await mount(app);
    await settle();
    expect(view.container.querySelector('[data-testid="board"]')).not.toBeNull();
    // The prompts are portalled to the document root (above every body-level menu and sheet), not drawn inside the frame.
    expect(document.body.querySelectorAll('[data-testid="access-prompts"]')).toHaveLength(1);
    await view.unmount();
  });

  test('G105 with no provision nothing is drawn, and the shell draws no prompt of its own', async () => {
    go('/d/d1/board');
    const { app } = setup(undefined);
    const view = await mount(app);
    await settle();
    expect(document.body.querySelector('[data-testid="access-prompts"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await view.unmount();
  });

  test('G105 a plugin that knows nothing of passkeys has its refusal asked about and its call sent again once', async () => {
    go('/d/d1/board');
    const { made, asked } = provision();
    const { app, transport } = setup(made);
    const view = await mount(app);
    await settle();
    const answer = await boardClient?.call('POST /v1/board', { body: { title: 'x' } });
    expect(answer).toEqual({ ok: true });
    expect(asked).toEqual([{ kind: 'step-up' }]);
    expect(transport.paths().filter(path => path === 'POST /v1/board')).toHaveLength(2);
    await view.unmount();
  });

  test('G105 only Access may provide the prompt: another plugin’s provision is ignored', () => {
    const { made } = provision();
    const intruder = provideToShell(implementApp(intruderManifest, { build: () => ({}) }), { passkey: () => made });
    const daemons = new DaemonList({ storage: memoryStore(), now: () => 1 });
    const registered = registeredPasskey([...CORE, entry(intruderManifest, intruder)], {
      clientOf: () => undefined,
      daemons,
      origin: 'https://app.example',
      credentials: { create: async () => null, get: async () => null },
    });
    expect(registered.passkey).toBeUndefined();
  });

  test('G105 the host asks for the client by the provider the registry found, never by a name of its own', () => {
    const asked: string[] = [];
    let seen: PasskeyPorts | undefined;
    const spy = provideToShell(implementApp(accessManifest, { build: () => ({}) }), {
      passkey: ports => {
        seen = ports;
        return provision().made;
      },
    });
    registeredPasskey([...CORE, entry(accessManifest, spy)], {
      clientOf: (daemon, plugin) => {
        asked.push(`${daemon}:${plugin}`);
        return undefined;
      },
      daemons: new DaemonList({ storage: memoryStore(), now: () => 1 }),
      origin: 'https://app.example',
      credentials: { create: async () => null, get: async () => null },
    });
    seen?.client('d1');
    expect(asked).toEqual(['d1:access']);
  });

  test('G105 a provision that throws is left out and said, never thrown', () => {
    const broken = provideToShell(implementApp(accessManifest, { build: () => ({}) }), {
      passkey: () => {
        throw new Error('no credentials here');
      },
    });
    const registered = registeredPasskey([...CORE, entry(accessManifest, broken)], {
      clientOf: () => undefined,
      daemons: new DaemonList({ storage: memoryStore(), now: () => 1 }),
      origin: 'https://app.example',
      credentials: { create: async () => null, get: async () => null },
    });
    expect(registered.passkey).toBeUndefined();
    expect(registered.failures).toEqual([{ plugin: 'access', reason: 'no credentials here' }]);
  });
});

describe('G95 the machine on screen', () => {
  test('G95 the prompts are told the machine the route names', async () => {
    go('/d/d2/board');
    const { made, focused } = provision();
    const { app } = setup(made);
    const view = await mount(app);
    await settle();
    expect(focused.at(-1)).toBe('d2');
    await view.unmount();
  });

  test('G95 a page that names no machine tells them the selected one', async () => {
    go('/');
    const { made, focused } = provision();
    const { app, daemons } = setup(made);
    const view = await mount(app);
    await settle();
    expect(focused.at(-1)).toBe(daemons.snapshot().selected);
    await view.unmount();
  });
});
