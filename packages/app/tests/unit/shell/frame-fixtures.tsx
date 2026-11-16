import type { Manifest } from '@ferretry/kernel/manifest';
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { type DaemonlessPorts, registeredDaemonless } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import type { PasskeyHandler, PasskeyNeed, PasskeyProvision, PromptOrigin } from '../../../src/passkey/passkey.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import type { InstallPromptHolder } from '../../../src/shell/device-context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, type Mounted, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * A WHOLE APP over fake machines, for the frame suites (S4, S5, S7, S13): the real `App` (router, frame, runtime) over a
 * list of surfaces, paired machines that answer an inventory and grants (or the real-shaped `401 unlock_required` while
 * locked), and a passkey handler that records every prompt with its origin. A background confirm waits (as the real
 * gate's does for a machine that is not on screen) until the test unlocks the machine.
 */

export const manifestOf = (id: string, extra: Record<string, unknown> = {}): Manifest =>
  ({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: ['view'], ...extra }) as unknown as Manifest;

export const route = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  minimum: 'authenticated',
  caller: 'any',
  audit: 'skip',
  ...extra,
});

export const entryOf = (manifest: Manifest, app: SurfaceEntry['app']): SurfaceEntry => ({
  id: manifest.id,
  title: manifest.title,
  core: false,
  contract: `h-${manifest.id}`,
  consumes: [],
  manifest,
  ...(app === undefined ? {} : { app }),
});

const UNLOCK_BODY = {
  error: 'this machine asks you to confirm it is you with a passkey before it shows anything',
  code: 'unlock_required',
};

const grants = (configure: boolean) => ({
  capabilities: [
    {
      capability: 'fleet',
      use: true,
      configure,
      granted: { use: true, configure: true },
      useRefusal: 'granted',
      configureRefusal: configure ? 'granted' : 'not-granted',
      mayGrant: false,
      origin: 'default',
    },
  ],
  governed: true,
  hostLocal: false,
  steppedUp: false,
});

export interface Machine {
  readonly transport: FakeTransport;
  locked: boolean;
  /** Plugins that are off on this machine. */
  off: Set<string>;
  /** The grants answer for `fleet.configure` (false: this device may only view). */
  viewOnly: boolean;
  /** What a route answers (by `METHOD /path`); anything else answers `{ ok: true }`. */
  answers: Map<string, unknown>;
}

interface Prompt {
  readonly need: PasskeyNeed;
  readonly origin: PromptOrigin;
  readonly daemon: string;
}

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

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

export interface BootOptions {
  readonly surfaces: readonly SurfaceEntry[];
  readonly machines: readonly string[];
  readonly path?: string;
  readonly viewport?: 'wide' | 'phone';
  readonly locked?: readonly string[];
  /** Machines whose grants let this device view but not configure. */
  readonly viewOnly?: readonly string[];
  readonly off?: Readonly<Record<string, readonly string[]>>;
  readonly install?: InstallPromptHolder;
  readonly storage?: ReturnType<typeof memoryStore>;
  /** Machines are paired before the first render unless a test pairs them later. */
  readonly pairLater?: boolean;
}

export async function bootApp(options: BootOptions) {
  const surfaces: readonly SurfaceEntry[] = [...CORE, ...options.surfaces];
  window.history.replaceState(null, '', options.path ?? '/');
  const machines = new Map<string, Machine>();
  const prompts: Prompt[] = [];
  const waiting = new Map<string, (() => void)[]>();
  const focused: (string | null)[] = [];
  const make = (id: string): Machine => {
    const machine: Machine = {
      locked: options.locked?.includes(id) ?? false,
      off: new Set(options.off?.[id] ?? []),
      viewOnly: options.viewOnly?.includes(id) ?? false,
      answers: new Map(),
      transport: new FakeTransport((request: TransportRequest): TransportAnswer => {
        if (request.path === '/v1/plugins') {
          const off = Object.fromEntries([...machine.off].map(plugin => [plugin, { on: false }]));
          return json(inventoryOf(surfaces, off));
        }
        if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
        if (machine.locked) return json(UNLOCK_BODY, 401);
        if (request.path === '/v1/grants') return json(grants(!machine.viewOnly));
        const answer = machine.answers.get(`${request.method} ${request.path}`);
        return json(answer ?? { ok: true });
      }),
    };
    machines.set(id, machine);
    return machine;
  };
  for (const id of options.machines) make(id);
  const handler: PasskeyHandler = {
    need: refusal => {
      const code = (refusal.body as { code?: unknown } | null)?.code;
      return refusal.status === 401 && code === 'unlock_required' ? { kind: 'unlock' } : undefined;
    },
    confirm: async (paired, need, origin) => {
      prompts.push({ need, origin, daemon: paired.daemon });
      const machine = machines.get(paired.daemon);
      if (origin === 'background') {
        // The real gate shows nothing for a machine that is not on screen: the call waits until it is unlocked.
        await new Promise<void>(resolve =>
          waiting.set(paired.daemon, [...(waiting.get(paired.daemon) ?? []), resolve]),
        );
        return machine?.locked === false;
      }
      if (machine !== undefined) machine.locked = false;
      for (const resolve of waiting.get(paired.daemon) ?? []) resolve();
      waiting.delete(paired.daemon);
      return true;
    },
    ask: async () => false,
    focus: daemon => void focused.push(daemon),
    locked: () => [],
    subscribe: () => () => {},
  };
  const provision = { handler, Prompts: () => null } as unknown as PasskeyProvision;
  const list = new DaemonList({ storage: memoryStore(), now: () => 1 });
  const pair = (id: string): void => {
    if (!machines.has(id)) make(id);
    list.add({ daemon: id, machine: `${id}-host`, deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  };
  if (options.pairLater !== true) for (const id of options.machines) pair(id);
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons: list,
    connect: async paired => machines.get(paired.daemon)?.transport,
    passkey: () => provision,
    daemonless: {
      views: registeredDaemonless(surfaces, {} as DaemonlessPorts).views,
      location: () => window.location.href,
    },
  });
  const storage = options.storage ?? memoryStore();
  const view: Mounted = await mount(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={options.viewport === 'phone' ? phone : wide}
      scroll={new ScrollMemory(null)}
      {...(options.install === undefined ? {} : { install: options.install })}
    />,
  );
  await settle();
  const machine = (id: string): Machine => {
    const found = machines.get(id);
    if (found === undefined) throw new Error(`no machine ${id}`);
    return found;
  };
  return {
    runtime,
    list,
    view,
    prompts,
    focused,
    machine,
    pair,
    /** Unlocks one machine as the person would (an explicit confirm): its waiting background calls go again. */
    unlock: async (id: string): Promise<void> => {
      machine(id).locked = false;
      for (const resolve of waiting.get(id) ?? []) resolve();
      waiting.delete(id);
      await settle();
    },
    /** Re-reads one machine's inventory (a plugin turned on or off there). */
    reread: async (id: string): Promise<void> => {
      const connection = runtime.connection(id);
      if (connection.kind !== 'connected') throw new Error('not connected');
      await connection.client.refresh();
      await settle();
    },
  };
}
