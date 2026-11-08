import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest, type PluginClient } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import type { AuthoritySignal, DaemonClient, ShellPluginClient } from '../../../src/client/daemon-client.ts';
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import type { PasskeyHandler, PasskeyNeed, PasskeyProvision, PromptOrigin } from '../../../src/passkey/passkey.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { GrantsCache, type GrantsReader } from '../../../src/shell/grants-cache.ts';
import { useLockedDaemons } from '../../../src/shell/passkey-mount.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import {
  CHECKING_LINE,
  controlState,
  UNREADABLE_LINE,
  useViewPlace,
  type ViewPlace,
} from '../../../src/shell/view-place.tsx';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { changeRefusalExplanation } from '../../../src/ui/change-authority.ts';
import { interact, type Mounted, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * WHERE A VIEW IS DRAWN, AND WHAT THIS DEVICE MAY DO THERE (shell contract S1): the one per-daemon grants cache, its
 * tri-state authority, the `locked` state a Gate-locked machine reads as (ruling #54), and `press`.
 */

const MEMORY = 'PATCH /v1/conv/memory';
const READ = 'GET /v1/conv/thread';
const SEND = 'POST /v1/conv/send';
const ADMIN = 'POST /v1/conv/admin';
const STREAM = 'GET /v1/conv/stream';
const route = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  minimum: 'authenticated',
  caller: 'any',
  audit: 'skip',
  ...extra,
});
const manifest = {
  id: 'conv',
  title: 'Conv',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  actions: {
    routes: [
      route(MEMORY, { capability: { capability: 'fleet', axis: 'configure' } }),
      route(READ),
      route(SEND),
      route(ADMIN, { minimum: 'admin-token' }),
    ],
    sockets: [route(STREAM)],
  },
  ui: { screens: [{ id: 'main', path: 'main' }] },
} as unknown as Manifest;

const seen: { place?: ViewPlace | null; client?: PluginClient; locked?: readonly string[] } = {};
function Probe({ client }: { readonly client: PluginClient }): ReactNode {
  const place = useViewPlace();
  seen.place = place;
  seen.client = client;
  seen.locked = useLockedDaemons();
  if (place === null) return null;
  const state = controlState(place.authorityOf(MEMORY));
  return (
    <div>
      <span data-testid="machine">{place.machine}</span>
      <span data-testid="online">{place.online ? 'online' : 'offline'}</span>
      {state.shown ? (
        <button
          type="button"
          data-testid="act"
          disabled={!state.enabled}
          onClick={() => void place.press(() => client.call(MEMORY, { body: { at: 1 } })).catch(() => {})}
        >
          {state.note ?? 'Compact memory at'}
        </button>
      ) : (
        <span data-testid="hidden">hidden</span>
      )}
    </div>
  );
}
const conv: SurfaceEntry = {
  id: 'conv',
  title: 'Conv',
  core: false,
  contract: 'h-conv',
  consumes: [],
  manifest,
  app: implementApp(manifest, { build: ({ client }) => ({ screens: { main: () => <Probe client={client} /> } }) }),
};
const surfaces: SurfaceEntry[] = [...CORE, conv];

/** Gate's grants view row for one capability, as `GET /v1/grants` answers it. */
const row = (capability: string, configure: boolean, configureRefusal = configure ? 'granted' : 'not-granted') => ({
  capability,
  use: true,
  configure,
  granted: { use: true, configure: true },
  useRefusal: 'granted',
  configureRefusal,
  mayGrant: false,
  origin: 'default',
});
const grants = (...rows: unknown[]) => ({ capabilities: rows, governed: true, hostLocal: false, steppedUp: false });
/** The refusal as Gate's admission builds it (`admission.ts`, `errorResponse(401, …, UNLOCK_REQUIRED_CODE)`). */
const UNLOCK_BODY = {
  error: 'this machine asks you to confirm it is you with a passkey before it shows anything',
  code: 'unlock_required',
};
const STEP_UP_BODY = {
  error: 'Changing the agent fleet from here needs your passkey.',
  code: 'grant_step_up_required',
  demand: { capability: 'fleet', axis: 'configure' },
};

interface Daemon {
  transport: FakeTransport;
  locked: boolean;
  grants: () => TransportAnswer | Promise<TransportAnswer>;
  answer: (request: TransportRequest) => TransportAnswer | Promise<TransportAnswer> | undefined;
  inventory: Record<string, { on?: boolean } | null>;
}

function daemonOf(): Daemon {
  const daemon: Daemon = {
    locked: false,
    grants: () => json(grants(row('fleet', true))),
    answer: () => undefined,
    inventory: {},
    transport: new FakeTransport(async request => {
      if (request.path === '/v1/plugins') return json(inventoryOf(surfaces, daemon.inventory));
      if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
      if (daemon.locked) return json(UNLOCK_BODY, 401);
      if (request.path === '/v1/grants') return daemon.grants();
      return (await daemon.answer(request)) ?? json({ ok: true });
    }),
  };
  return daemon;
}

interface Prompt {
  readonly need: PasskeyNeed;
  readonly origin: PromptOrigin;
  readonly daemon: string;
}

function setup(options: { daemons?: readonly string[]; selected?: string } = {}) {
  const ids = options.daemons ?? ['d1'];
  const machines = new Map(ids.map(id => [id, daemonOf()]));
  const prompts: Prompt[] = [];
  const focused: (string | null)[] = [];
  const asked: string[] = [];
  let answerPrompt: (prompt: Prompt) => Promise<boolean> = async () => false;
  const handler: PasskeyHandler = {
    need: refusal => {
      const code = (refusal.body as { code?: unknown } | null)?.code;
      if (refusal.status === 401 && code === 'unlock_required') return { kind: 'unlock' };
      if (refusal.status === 403 && code === 'grant_step_up_required') return { kind: 'step-up' };
      return undefined;
    },
    confirm: async (paired, need, origin) => {
      const prompt = { need, origin, daemon: paired.daemon };
      prompts.push(prompt);
      const confirmed = await answerPrompt(prompt);
      if (confirmed && need.kind === 'unlock') {
        const machine = machines.get(paired.daemon);
        if (machine !== undefined) machine.locked = false;
      }
      return confirmed;
    },
    ask: async paired => {
      asked.push(paired.daemon);
      return true;
    },
    focus: daemon => void focused.push(daemon),
    locked: () => [],
    subscribe: () => () => {},
  };
  const provision = { handler, Prompts: () => null } as unknown as PasskeyProvision;
  const list = new DaemonList({ storage: memoryStore(), now: () => 1 });
  for (const id of ids)
    list.add({ daemon: id, machine: `${id}-host`, deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  if (options.selected !== undefined) list.select(options.selected);
  let visible: (() => void) | undefined;
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons: list,
    connect: async paired => machines.get(paired.daemon)?.transport,
    passkey: () => provision,
    onVisible: listener => {
      visible = listener;
      return () => {};
    },
  });
  return {
    runtime,
    list,
    machines,
    machine: (id = 'd1') => machines.get(id) as Daemon,
    prompts,
    focused,
    asked,
    handler,
    answer: (next: (prompt: Prompt) => Promise<boolean>) => {
      answerPrompt = next;
    },
    backOnScreen: () => visible?.(),
    grantsReads: (id = 'd1') =>
      (machines.get(id) as Daemon).transport.paths().filter(path => path === 'GET /v1/grants').length,
    client: (id = 'd1') => {
      const connection = runtime.connection(id);
      if (connection.kind !== 'connected') throw new Error('not connected');
      return connection.client;
    },
  };
}

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};
const go = (path: string): void => window.history.replaceState({}, '', path);
let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  go('/');
  delete seen.place;
});

async function open(parts: ReturnType<typeof setup>, path = '/d/d1/main'): Promise<Mounted> {
  go(path);
  const storage = memoryStore();
  view = await mount(
    <App
      runtime={parts.runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />,
  );
  await settle();
  return view;
}
const act = (): HTMLButtonElement | null => view?.container.querySelector('[data-testid="act"]') ?? null;
const click = async (element: Element | null): Promise<void> => {
  await interact(() => (element as HTMLElement).click());
  await settle();
};
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('the view place', () => {
  test('before the read: unknown, disabled with the checking line, in the same box', async () => {
    const parts = setup();
    const slow = deferred<TransportAnswer>();
    parts.machine().grants = () => slow.promise;
    await open(parts);
    const before = act();
    expect(before?.disabled).toBe(true);
    expect(before?.textContent).toBe(CHECKING_LINE);
    slow.resolve(json(grants(row('fleet', true))));
    await settle();
    expect(act()).toBe(before);
    expect(act()?.disabled).toBe(false);
    expect(act()?.textContent).toBe('Compact memory at');
    expect(seen.place?.machine).toBe('d1-host');
  });

  test('a locked machine (the real 401 unlock_required) reads locked, shows the control, and a press asks first', async () => {
    const parts = setup();
    parts.machine().locked = true;
    await open(parts);
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'locked' });
    expect(seen.place?.authority('terminal', 'use')).toEqual({ kind: 'locked' });
    expect(act()?.disabled).toBe(false);
    expect(act()?.textContent).toBe('Compact memory at');
    // The no-pause read raised nothing, though the machine is not "on screen" for the handler until focus.
    expect(parts.prompts).toEqual([]);
    expect(seen.locked).toEqual(['d1']);
    const reads = parts.grantsReads();
    parts.answer(async () => true);
    await click(act());
    expect(parts.prompts).toEqual([{ need: { kind: 'unlock' }, origin: 'explicit', daemon: 'd1' }]);
    // The act was sent once, after the unlock, and the grants were read again.
    expect(
      parts
        .machine()
        .transport.paths()
        .filter(path => path === 'PATCH /v1/conv/memory'),
    ).toHaveLength(1);
    expect(parts.grantsReads()).toBeGreaterThan(reads);
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'open' });
    expect(seen.locked).toEqual([]);
  });

  test('a dismissed unlock leaves locked, never the could-not-read sentence, and runs nothing', async () => {
    const parts = setup();
    parts.machine().locked = true;
    await open(parts);
    await click(act());
    expect(parts.prompts).toHaveLength(1);
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'locked' });
    expect(act()?.textContent).toBe('Compact memory at');
    expect(parts.machine().transport.paths()).not.toContain('PATCH /v1/conv/memory');
  });

  test('after an unlock with per-act step-up on, configure reads step-up and a press raises the step-up', async () => {
    const parts = setup();
    const machine = parts.machine();
    machine.grants = () => json(grants(row('fleet', false, 'step-up-required')));
    machine.answer = request => (request.method === 'PATCH' ? json(STEP_UP_BODY, 403) : undefined);
    await open(parts);
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'step-up' });
    expect(controlState({ kind: 'step-up' })).toEqual({ shown: true, enabled: true });
    await click(act());
    expect(parts.prompts.map(prompt => prompt.need.kind)).toEqual(['step-up']);
    expect(parts.prompts[0]?.origin).toBe('explicit');
  });

  test('not-granted and device-not-granted hide; undetermined and unreadable disable with a sentence', async () => {
    const parts = setup();
    const machine = parts.machine();
    machine.grants = () => json(grants(row('fleet', false, 'not-granted')));
    await open(parts);
    expect(view?.container.querySelector('[data-testid="hidden"]')).not.toBeNull();
    machine.grants = () => json(grants(row('fleet', false, 'device-not-granted')));
    parts.backOnScreen();
    await settle();
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'refused', refusal: 'device-not-granted' });
    expect(view?.container.querySelector('[data-testid="hidden"]')).not.toBeNull();
    machine.grants = () => json(grants(row('fleet', false, 'undetermined')));
    parts.backOnScreen();
    await settle();
    expect(act()?.disabled).toBe(true);
    expect(act()?.textContent).toBe(changeRefusalExplanation('undetermined'));
    // A refusal reason Gate never sends ('granted' with the axis off) reads as the stricter undetermined.
    machine.grants = () => json(grants(row('fleet', false, 'granted')));
    parts.backOnScreen();
    await settle();
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'refused', refusal: 'undetermined' });
    // A capability the answer has no row for is undetermined, never open.
    expect(seen.place?.authority('terminal', 'use')).toEqual({ kind: 'refused', refusal: 'undetermined' });
    machine.grants = () => json({ nonsense: true });
    parts.backOnScreen();
    await settle();
    expect(act()?.disabled).toBe(true);
    expect(act()?.textContent).toBe(UNREADABLE_LINE);
    machine.grants = () => json({ error: 'boom', code: 'boom' }, 500);
    parts.backOnScreen();
    await settle();
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'unreadable' });
  });

  test('authorityOf: an undeclared route is unknown, an admin-token route not-granted, an ungoverned one open', async () => {
    const parts = setup();
    await open(parts);
    expect(seen.place?.authorityOf('GET /v1/nowhere')).toEqual({ kind: 'unknown' });
    expect(seen.place?.authorityOf(ADMIN)).toEqual({ kind: 'refused', refusal: 'not-granted' });
    expect(seen.place?.authorityOf(READ)).toEqual({ kind: 'open' });
    parts.machine().locked = true;
    parts.backOnScreen();
    await settle();
    expect(seen.place?.authorityOf(READ)).toEqual({ kind: 'locked' });
    // The descriptor alone refuses an admin-token route, locked or not.
    expect(seen.place?.authorityOf(ADMIN)).toEqual({ kind: 'refused', refusal: 'not-granted' });
  });

  test('re-read on each trigger: a capability 403, a reconnect, the foreground, kernel.plugins-changed, a confirm', async () => {
    const parts = setup();
    const machine = parts.machine();
    await open(parts);
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'open' });
    const flip = async (configure: boolean, trigger: () => unknown): Promise<void> => {
      machine.grants = () => json(grants(row('fleet', configure)));
      await interact(async () => {
        await trigger();
      });
      await settle();
      expect(seen.place?.authorityOf(MEMORY)).toEqual(
        configure ? { kind: 'open' } : { kind: 'refused', refusal: 'not-granted' },
      );
    };
    // A capability 403 seen by the daemon's client.
    machine.answer = request =>
      request.method === 'POST' ? json({ error: 'off', code: 'grant_not_granted' }, 403) : undefined;
    await flip(false, () => seen.client?.call(SEND).catch(() => {}));
    await flip(true, () => machine.transport.reconnect());
    await flip(false, () => parts.backOnScreen());
    await flip(true, () => machine.transport.emit({ name: 'kernel.plugins-changed', payload: { generation: 4 } }));
    // A confirm the shell forwards (usePasskeyAsk's) re-reads too.
    await flip(false, () => parts.runtime.noteConfirmed('d1'));
    // The feed coming back is a trigger as well.
    await flip(true, () => machine.transport.openFeed());
  });

  test('a 401 unlock_required on any call flips the machine to locked with no read', async () => {
    const parts = setup();
    const machine = parts.machine();
    await open(parts);
    const reads = parts.grantsReads();
    machine.locked = true;
    await interact(async () => {
      await seen.client?.call(SEND).catch(() => {});
    });
    await settle();
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'locked' });
    expect(parts.grantsReads()).toBe(reads);
  });

  test('a paused plugin does not stop the grants read, and the no-pause read is not a plugin client’s', async () => {
    const parts = setup();
    parts.machine().inventory = { conv: { on: false } };
    parts.runtime.connection('d1');
    await settle();
    expect(parts.grantsReads()).toBe(1);
    expect(parts.runtime.authority('d1', 'fleet', 'configure')).toEqual({ kind: 'open' });
    const plugin: ShellPluginClient = parts.client().forPackage('conv');
    // @ts-expect-error readGrants is the shell's own read: DaemonClient only, never on a plugin's client.
    expect(plugin.readGrants).toBeUndefined();
    // Mutation row: adding `noPause` to `forPackage` goes red under `tsc` (this line), not under `bun test`.
    // @ts-expect-error there is no noPause option on a plugin's client.
    parts.client().forPackage('conv', { noPause: true });
    const shell: Pick<DaemonClient, 'readGrants'> = parts.client();
    expect(typeof shell.readGrants).toBe('function');
  });

  test('press: a GET-first and a socket-first act on an off-screen locked machine ask at once; dismissed runs nothing', async () => {
    const parts = setup({ daemons: ['d1', 'd2'], selected: 'd1' });
    await open(parts);
    parts.machine('d2').locked = true;
    parts.runtime.connection('d2');
    await settle();
    expect(parts.runtime.lockedDaemons()).toEqual(['d2']);
    const client = parts.runtime.client('d2', 'conv');
    let ran = 0;
    const ranGet = await parts.runtime.press('d2', async () => {
      ran += 1;
      return await client?.call(READ);
    });
    expect(ranGet).toBeUndefined();
    expect(ran).toBe(0);
    expect(parts.prompts).toEqual([{ need: { kind: 'unlock' }, origin: 'explicit', daemon: 'd2' }]);
    parts.answer(async () => true);
    const opened = await parts.runtime.press('d2', async () =>
      client?.socket(STREAM, {}, { onFrame: () => {}, onClose: () => {} }),
    );
    expect(opened).toBeDefined();
    expect(parts.prompts.map(prompt => prompt.origin)).toEqual(['explicit', 'explicit']);
    // Nothing called focus but PasskeyMount (which focused the machine on screen, d1).
    expect(parts.focused.every(daemon => daemon === 'd1')).toBe(true);
    // An unpaired daemon, and a runtime with no passkey, cannot unlock.
    expect(await parts.runtime.unlock('nobody')).toBe(false);
  });

  test('a stale 401, sent before an unlock and answered after the re-read said open, leaves open', async () => {
    const parts = setup();
    const machine = parts.machine();
    await open(parts);
    machine.locked = true;
    parts.backOnScreen();
    await settle();
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'locked' });
    // A read sent now, under this generation, is held by the daemon …
    const held = deferred<TransportAnswer>();
    machine.answer = () => held.promise;
    machine.locked = false;
    const late = seen.client?.call(READ).catch(() => {});
    await settle();
    // … the person unlocks (a new generation) and the re-read says open …
    parts.answer(async () => true);
    expect(await parts.runtime.unlock('d1')).toBe(true);
    await settle();
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'open' });
    // … and the old request's 401 lands after: ignored.
    parts.answer(async () => false);
    held.resolve(json(UNLOCK_BODY, 401));
    await interact(async () => {
      await late;
    });
    await settle();
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'open' });
  });

  test('m4 a grants read sent before a 401 unlock_required and answered after it leaves the machine locked', async () => {
    const parts = setup();
    const machine = parts.machine();
    await open(parts);
    // A re-read is sent (the app came back) and the daemon holds its answer …
    const heldRead = deferred<TransportAnswer>();
    machine.grants = () => heldRead.promise;
    parts.backOnScreen();
    await settle();
    // … the unlock expires and a plugin call's 401 (same generation) says locked …
    machine.locked = true;
    await interact(async () => {
      await seen.client?.call(SEND).catch(() => {});
    });
    await settle();
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'locked' });
    // … and the older read answers 200 afterwards: it does not undo the locked.
    heldRead.resolve(json(grants(row('fleet', true))));
    await settle();
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'locked' });
    expect(parts.runtime.lockedDaemons()).toEqual(['d1']);
  });

  test('one locked set: a locked machine with nothing parked is in useLockedDaemons', async () => {
    const parts = setup();
    parts.machine().locked = true;
    await open(parts);
    expect(parts.handler.locked()).toEqual([]);
    expect(seen.locked).toEqual(['d1']);
  });

  test('online follows the feed; the machine is the owner label else the name', async () => {
    const parts = setup();
    await open(parts);
    expect(view?.container.querySelector('[data-testid="online"]')?.textContent).toBe('offline');
    await interact(() => parts.machine().transport.openFeed());
    expect(view?.container.querySelector('[data-testid="online"]')?.textContent).toBe('online');
    await interact(() => parts.machine().transport.dropFeed());
    expect(view?.container.querySelector('[data-testid="online"]')?.textContent).toBe('offline');
    await interact(() => parts.list.rename('d1', 'Laptop'));
    expect(view?.container.querySelector('[data-testid="machine"]')?.textContent).toBe('Laptop');
  });

  test('a view reads its own daemon’s place, never the selected one; outside a shell it is null', async () => {
    const parts = setup({ daemons: ['d1', 'd2'], selected: 'd2' });
    parts.machine('d2').grants = () => json(grants(row('fleet', false, 'not-granted')));
    await open(parts, '/d/d1/main');
    expect(seen.place?.daemon).toBe('d1');
    expect(seen.place?.authorityOf(MEMORY)).toEqual({ kind: 'open' });
    expect(parts.runtime.authorityOf('d2', MEMORY)).toEqual({ kind: 'refused', refusal: 'not-granted' });
    await view?.unmount();
    view = await mount(<Probe client={{} as PluginClient} />);
    expect(seen.place).toBeNull();
  });

  test('the place is one object until the runtime changes; an unpair forgets the machine', async () => {
    const parts = setup();
    await open(parts);
    const place = parts.runtime.place('d1');
    expect(parts.runtime.place('d1')).toBe(place);
    await interact(() => parts.list.remove('d1'));
    expect(parts.runtime.lockedDaemons()).toEqual([]);
    expect(parts.runtime.authority('d1', 'fleet', 'use')).toEqual({ kind: 'unknown' });
    expect(parts.runtime.place('d1').machine).toBe('d1');
  });
});

describe('the grants cache', () => {
  /** A fake no-pause reader: each read waits for the test to answer it. */
  function reader() {
    const pending: {
      generation: number;
      settle: (read: Awaited<ReturnType<GrantsReader['readGrants']>>) => void;
      fail: () => void;
    }[] = [];
    let listener: (signal: AuthoritySignal) => void = () => {};
    const client = {
      generation: 0,
      readGrants: () =>
        new Promise<Awaited<ReturnType<GrantsReader['readGrants']>>>((settle, fail) => {
          pending.push({ generation: client.generation, settle, fail: () => fail(new Error('stopped')) });
        }),
      onAuthority: (next: (signal: AuthoritySignal) => void) => {
        listener = next;
        return () => {};
      },
    };
    return { client, pending, signal: (signal: AuthoritySignal) => listener(signal) };
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const open = (generation = 0) => ({ generation, answer: json(grants(row('fleet', true))), need: undefined });

  test('a trigger during a read sends ONE more read after it, and a rejected read is unreadable', async () => {
    let changes = 0;
    const cache = new GrantsCache(() => {
      changes += 1;
    });
    const fake = reader();
    cache.attach('d1', fake.client);
    cache.refresh('d1');
    cache.refresh('d1');
    cache.refreshAll();
    expect(fake.pending).toHaveLength(1);
    fake.pending[0]?.settle(open());
    await flush();
    expect(fake.pending).toHaveLength(2);
    expect(cache.authority('d1', 'fleet', 'configure')).toEqual({ kind: 'open' });
    fake.pending[1]?.fail();
    await flush();
    expect(cache.authority('d1', 'fleet', 'configure')).toEqual({ kind: 'unreadable' });
    expect(changes).toBeGreaterThan(0);
  });

  test('a read that reached nothing keeps the last answer; an answer for a dropped daemon changes nothing', async () => {
    const cache = new GrantsCache(() => {});
    const fake = reader();
    cache.attach('d1', fake.client);
    cache.refresh('d1');
    fake.pending[0]?.settle({ generation: 0, answer: undefined, need: undefined });
    await flush();
    expect(cache.authority('d1', 'fleet', 'use')).toEqual({ kind: 'unknown' });
    cache.refresh('d1');
    fake.pending[1]?.settle(open());
    await flush();
    cache.refresh('d1');
    cache.refresh('d1');
    fake.pending[2]?.settle({ generation: 0, answer: undefined, need: undefined });
    await flush();
    expect(cache.authority('d1', 'fleet', 'use')).toEqual({ kind: 'open' });
    cache.refresh('d1');
    cache.drop('d1');
    cache.drop('d1');
    fake.pending[3]?.fail();
    fake.pending[4]?.settle(open());
    await flush();
    expect(cache.authority('d1', 'fleet', 'use')).toEqual({ kind: 'unknown' });
    cache.refresh('d1');
    fake.signal({ kind: 'locked', generation: 0 });
    expect(cache.locked()).toEqual([]);
  });

  test('refreshLocked re-reads only the locked machines; a stale signal changes nothing', async () => {
    const cache = new GrantsCache(() => {});
    const a = reader();
    const b = reader();
    cache.attach('a', a.client);
    cache.attach('b', b.client);
    a.signal({ kind: 'locked', generation: 0 });
    expect(cache.locked()).toEqual(['a']);
    const same = cache.locked();
    a.signal({ kind: 'locked', generation: 0 });
    expect(cache.locked()).toBe(same);
    cache.refreshLocked();
    expect(a.pending).toHaveLength(1);
    expect(b.pending).toHaveLength(0);
    a.client.generation = 1;
    a.pending[0]?.settle(open(0));
    await flush();
    expect(cache.isLocked('a')).toBe(true);
    b.signal({ kind: 'refused', generation: 5 });
    expect(b.pending).toHaveLength(0);
  });

  test('the runtime re-reads its locked machines when the handler changes, and a throwing confirm is not confirmed', async () => {
    const parts = setup();
    let notify: () => void = () => {};
    parts.handler.subscribe = listener => {
      notify = listener;
      return () => {};
    };
    parts.machine().locked = true;
    parts.runtime.connection('d1');
    await settle();
    const reads = parts.grantsReads();
    notify();
    await settle();
    expect(parts.grantsReads()).toBe(reads + 1);
    parts.answer(async () => {
      throw new Error('the prompt failed to open');
    });
    expect(await parts.runtime.unlock('d1')).toBe(false);
    expect(parts.runtime.lockedDaemons()).toEqual(['d1']);
  });
});
