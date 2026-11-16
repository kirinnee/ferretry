/**
 * V-0452 (m3): `GET /v1/bus` per viewer kind, through Gate's real `GateAdmission` (not a hand-written filter) and the
 * kernel host that serves the socket: who is shown which plugin's events.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AdmissionPort, defineEvent, type ApiRequest, type SocketDownstream } from '@ferretry/kernel/contract';
import { bootHost, realAdapters } from '@ferretry/kernel/host';
import { definePlugin, implementDaemon, route } from '@ferretry/kernel/manifest';
import { fixedClock } from '@ferretry/kernel/testing';
import { cap, DEFAULT_GATE_CONFIG, LIMITED_DEVICE_GRANTS } from '../../../contract/index.ts';
import { ADMIN, carried, FERRET_TOKEN, local, request, WARDEN, world, type World } from './support.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const events = {
  board: defineEvent('board.card-moved', z.strictObject({ n: z.number() })),
  voice: defineEvent('voice.heard', z.strictObject({ n: z.number() })),
  access: defineEvent('access.unlocked', z.strictObject({ n: z.number() })),
  warden: defineEvent('warden.watched', z.strictObject({ n: z.number() })),
};
type Id = keyof typeof events;

const SCOPE = { minimum: 'operator', caller: 'any', audit: { skip: 'test' }, guard: { none: 'test' } } as const;
const plugin = (id: Id, surface?: ReturnType<typeof cap>) =>
  definePlugin({
    id,
    title: id,
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    data: { publishes: [events[id]] },
    ...(surface === undefined
      ? {}
      : { actions: { routes: [route(`GET /v1/${id}/read`, { ...SCOPE, capability: surface })] } }),
  });
const gateManifest = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort },
});

const feed = () => {
  const sent: string[] = [];
  const port: SocketDownstream = {
    send: frame => {
      sent.push(String(frame));
      return String(frame).length;
    },
    close: () => {},
    bufferedBytes: () => 0,
  };
  return { port, names: () => sent.map(frame => (JSON.parse(frame) as { name: string }).name).sort() };
};

/** Boots the kernel over a real Gate, opens the bus as `call`, publishes one event per plugin, and says what arrived. */
async function seen(w: World, call: ApiRequest): Promise<readonly string[] | 'refused'> {
  const root = await mkdtemp(`${tmpdir()}/bus-viewers-`);
  roots.push(root);
  const home = `${root}/home`;
  const publish: Partial<Record<Id, () => void>> = {};
  const half = (id: Id) =>
    implementDaemon(plugin(id), {
      build: ({ kernel }) => {
        publish[id] = () => kernel.events.publish(events[id] as never, { n: 1 } as never);
        return {};
      },
    });
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(gateManifest, { build: () => ({ provides: { admission: w.gate } }) }),
      // Board and Voice declare a surface a grant decides; Access and Warden are the two names Gate always shows.
      implementDaemon(plugin('board', cap('fleet', 'use')), { build: half('board').build as never }),
      implementDaemon(plugin('voice', cap('terminal', 'use')), { build: half('voice').build as never }),
      half('access'),
      half('warden'),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    const decision = await outcome.host.dispatcher.upgrade(call);
    if (decision.outcome !== 'accepted') return 'refused';
    const out = feed();
    const handler = await decision.attach(out.port);
    await handler.open();
    for (const id of Object.keys(events) as Id[]) publish[id]?.();
    await Bun.sleep(5);
    handler.close();
    return out.names();
  } finally {
    await outcome.host.stop();
  }
}

const bus = (options: Parameters<typeof request>[0] = {}) => request({ path: '/v1/bus', ...options });

test('V-0452 a device with a grant sees that plugin’s events and Access’s, and no plugin its grants do not reach', async () => {
  const w = world();
  w.enrol('phone', LIMITED_DEVICE_GRANTS);
  expect(await seen(w, bus({ device: 'phone' }))).toEqual(['access.unlocked', 'board.card-moved']);
});

test('V-0452 a device with every grant sees every plugin that offers it a surface, and still not Warden', async () => {
  const w = world();
  w.enrol('laptop');
  expect(await seen(w, bus({ device: 'laptop' }))).toEqual(['access.unlocked', 'board.card-moved', 'voice.heard']);
});

test('V-0452 a ferret and the host’s own admin token see every plugin’s events', async () => {
  const all = ['access.unlocked', 'board.card-moved', 'voice.heard', 'warden.watched'];
  expect(await seen(world(), bus({ bearer: FERRET_TOKEN, arrival: local(true) }))).toEqual(all);
  expect(await seen(world(), bus({ bearer: ADMIN, arrival: local(true) }))).toEqual(all);
});

test('V-0452 a warden sees the core pieces and Warden, nothing else', async () => {
  expect(await seen(world(), bus({ bearer: WARDEN, arrival: local(false) }))).toEqual(['warden.watched']);
});

test('V-0452 a member is refused the bus', async () => {
  expect(await seen(world(), bus({ member: 'catalog-reader' }))).toBe('refused');
});

test('V-0452 an admin token that arrived relayed is governed like a device, by the daemon-wide grants alone', async () => {
  const narrowed = world({ policy: { ...DEFAULT_GATE_CONFIG, grants: LIMITED_DEVICE_GRANTS as never } });
  expect(await seen(narrowed, bus({ bearer: ADMIN, arrival: carried() }))).toEqual([
    'access.unlocked',
    'board.card-moved',
  ]);
  // with nothing narrowed it is still governed: Warden is never a device's to see
  expect(await seen(world(), bus({ bearer: ADMIN, arrival: carried() }))).toEqual([
    'access.unlocked',
    'board.card-moved',
    'voice.heard',
  ]);
});
