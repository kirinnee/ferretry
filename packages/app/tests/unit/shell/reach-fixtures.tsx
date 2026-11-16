import { implementApp, type Manifest, type PluginClient } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { type DaemonlessPorts, provideToShell, registeredDaemonless } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import type { PasskeyHandler, PasskeyNeed, PasskeyProvision, PromptOrigin } from '../../../src/passkey/passkey.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * Two plugins on up to three paired machines, for the S2 suites (`useEveryDaemon`, the plugin-identity context): `conv`
 * provides its own app hook and draws whatever screen a test hands it; `other` provides a hook of its own. Each machine
 * answers its inventory, its grants (or the real-shaped `401 unlock_required` while locked) and every other route.
 */

export const MEMORY = 'PATCH /v1/conv/memory';
export const READ = 'GET /v1/conv/thread';
export const SEND = 'POST /v1/conv/send';
export const OWN_HOOK = 'conv.store';
export const OTHER_HOOK = 'other.thing';

const route = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  minimum: 'authenticated',
  caller: 'any',
  audit: 'skip',
  ...extra,
});
const manifestOf = (id: string, extra: Record<string, unknown>): Manifest =>
  ({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: ['view'], ...extra }) as unknown as Manifest;

const convManifest = manifestOf('conv', {
  actions: {
    routes: [route(MEMORY, { capability: { capability: 'fleet', axis: 'configure' } }), route(READ), route(SEND)],
  },
  ui: {
    screens: [
      { id: 'main', path: 'main' },
      { id: 'landing', path: '/landing', daemonless: true },
    ],
  },
});
const otherManifest = manifestOf('other', { actions: { routes: [route('GET /v1/other')] }, ui: { screens: [] } });

/** What `conv`'s screen draws: a test sets it before it mounts. */
export const drawn: { screen: (client: PluginClient) => ReactNode; landing: () => ReactNode } = {
  screen: () => null,
  landing: () => null,
};
/** Every value `conv`'s own hook was built as, with the daemon it was built on. */
export const builds: { readonly daemon: string; readonly client: PluginClient; readonly value: object }[] = [];

const convApp = provideToShell(
  implementApp(convManifest, { build: ({ client }) => ({ screens: { main: () => drawn.screen(client) } }) }),
  {
    hooks: {
      [OWN_HOOK]: ({ client, daemon }) => {
        const value = { daemon };
        builds.push({ daemon, client, value });
        return value;
      },
    },
    daemonless: () => ({ landing: () => drawn.landing() }),
  },
);
const otherApp = provideToShell(implementApp(otherManifest, { build: () => ({}) }), {
  hooks: { [OTHER_HOOK]: () => ({ other: true }) },
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
const surfaces: SurfaceEntry[] = [...CORE, entry(convManifest, convApp), entry(otherManifest, otherApp)];

/** Gate's grants view row for one capability, as `GET /v1/grants` answers it. */
const row = (capability: string, configure: boolean) => ({
  capability,
  use: true,
  configure,
  granted: { use: true, configure: true },
  useRefusal: 'granted',
  configureRefusal: configure ? 'granted' : 'not-granted',
  mayGrant: false,
  origin: 'default',
});
const grants = (...rows: unknown[]) => ({
  capabilities: rows,
  governed: true,
  hostLocal: false,
  steppedUp: false,
});
/** The refusal as Gate's admission builds it (`admission.ts`). */
const UNLOCK_BODY = {
  error: 'this machine asks you to confirm it is you with a passkey before it shows anything',
  code: 'unlock_required',
};

export interface Machine {
  readonly transport: FakeTransport;
  locked: boolean;
  /** Plugins that are off on this machine. */
  off: Set<string>;
  configure: boolean;
}

interface Prompt {
  readonly need: PasskeyNeed;
  readonly origin: PromptOrigin;
  readonly daemon: string;
}

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

export function setup(ids: readonly string[] = ['d1', 'd2']) {
  const machines = new Map<string, Machine>();
  for (const id of ids) {
    const machine: Machine = {
      locked: false,
      off: new Set(),
      configure: true,
      transport: new FakeTransport((request: TransportRequest): TransportAnswer => {
        if (request.path === '/v1/plugins') {
          const off = Object.fromEntries([...machine.off].map(plugin => [plugin, { on: false }]));
          return json(inventoryOf(surfaces, off));
        }
        if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
        if (machine.locked) return json(UNLOCK_BODY, 401);
        if (request.path === '/v1/grants') return json(grants(row('fleet', machine.configure)));
        return json({ ok: true });
      }),
    };
    machines.set(id, machine);
  }
  const prompts: Prompt[] = [];
  const focused: (string | null)[] = [];
  let answer = false;
  const handler: PasskeyHandler = {
    need: refusal => {
      const code = (refusal.body as { code?: unknown } | null)?.code;
      return refusal.status === 401 && code === 'unlock_required' ? { kind: 'unlock' } : undefined;
    },
    confirm: async (paired, need, origin) => {
      prompts.push({ need, origin, daemon: paired.daemon });
      const machine = machines.get(paired.daemon);
      if (answer && machine !== undefined) machine.locked = false;
      return answer;
    },
    ask: async () => false,
    focus: daemon => void focused.push(daemon),
    locked: () => [],
    subscribe: () => () => {},
  };
  const provision = { handler, Prompts: () => null } as unknown as PasskeyProvision;
  const list = new DaemonList({ storage: memoryStore(), now: () => 1 });
  for (const id of ids)
    list.add({ daemon: id, machine: `${id}-host`, deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons: list,
    connect: async paired => machines.get(paired.daemon)?.transport,
    passkey: () => provision,
    daemonless: { views: registeredDaemonless(surfaces, {} as DaemonlessPorts).views, location: () => '' },
  });
  const machine = (id: string): Machine => {
    const found = machines.get(id);
    if (found === undefined) throw new Error(`no machine ${id}`);
    return found;
  };
  return {
    runtime,
    list,
    machine,
    prompts,
    focused,
    /** What the next prompt answers (and a confirmed unlock unlocks the machine). */
    answer: (next: boolean) => {
      answer = next;
    },
    /** Re-reads one machine's inventory (a plugin turned on or off there). */
    reread: async (id: string) => {
      const connection = runtime.connection(id);
      if (connection.kind !== 'connected') throw new Error('not connected');
      await connection.client.refresh();
      await settle();
    },
    /** Opens every paired machine's connection and lets the first reads answer. */
    connectAll: async () => {
      for (const id of ids) runtime.connection(id);
      await settle();
    },
  };
}
