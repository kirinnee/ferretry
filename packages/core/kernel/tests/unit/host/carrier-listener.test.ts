/**
 * The kernel's carrier listener (G15, G16, R625): a second loopback port that serves ONE declared socket route and
 * stamps every arrival `carried`. Real loopback sockets, a real dispatcher, a recording admission; no tmux.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Admission, AdmissionInput } from '../../../contract/bound.ts';
import type { Arrival } from '../../../contract/session.ts';
import type { Manifest } from '../../../manifest/types.ts';
import type { CarrierKey, PluginId } from '../../../contract/ids.ts';
import type { CarrierListenerHandle } from '../../../contract/ports.ts';
import { Carriers } from '../../../contract/kernel.ts';
import type { CallStanding } from '../../../contract/route.ts';
import { carrierListenerPort, CARRIER_SHARED_PEER } from '../../../host/carrier-listener.ts';
import { Dispatcher, type MountedSocket } from '../../../host/dispatch.ts';
import { definePlugin, socket } from '../../../manifest/index.ts';

const CARRIED: Arrival = { kind: 'carried', carrier: 'tunnel' as CarrierKey };
const DAEMON = 'fy_daemon_listener_fixture';
const ROUTE = 'GET /v1/rendezvous/:daemonId/client';
const PATH = `/v1/rendezvous/${DAEMON}/client`;

const declared = socket(ROUTE, {
  minimum: 'none',
  caller: 'any',
  audit: { skip: 'sealed' },
  guard: { none: 'sealed' },
});

const carrierPlugin = (takes: readonly string[] = ['tunnel']) =>
  definePlugin({
    id: 'carrierfix',
    title: 'Carrier fixture',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: ['carrier'],
    actions: { sockets: [declared] },
    hooks: { takes: takes.map(key => ({ hook: Carriers, key })) as never },
  });

/** What admission was asked: the arrival is the one fact that decides local from remote. */
interface Asked {
  readonly path: string;
  readonly arrival: AdmissionInput['request']['arrival'];
  readonly clientAddress: string | undefined;
}

function world(extra: readonly MountedSocket[] = [], refuse = false) {
  const asked: Asked[] = [];
  const attached: string[] = [];
  const admission: Admission = {
    admit: input => {
      asked.push({
        path: input.request.path,
        arrival: input.request.arrival,
        clientAddress: input.request.clientAddress,
      });
      if (refuse)
        return {
          outcome: 'refused',
          response: { status: 403, headers: new Map(), body: '{"error":"not admitted","code":"forbidden"}' },
        };
      return { outcome: 'admitted', standing: { actor: 'device' } as unknown as CallStanding, actor: 'owner-tools' };
    },
    admitMember: () => {
      throw new Error('no member call in this fixture');
    },
    readmit: () => true,
    inventory: (_request, entries) => entries,
  };
  const owner = (plugin: string) => ({
    plugin: plugin as PluginId,
    title: plugin,
    serving: () => ({ kind: 'serving' as const }),
  });
  const mounted: MountedSocket = {
    ...declared,
    owner: owner('carrierfix'),
    accept: async call => {
      attached.push(call.request.path);
      return async () => ({ open: async () => undefined, fromClient: () => undefined, close: () => undefined });
    },
  };
  const dispatcher = new Dispatcher(
    { admission: () => admission, outputGuard: () => undefined, version: '5.0.0' },
    { routes: [], sockets: [mounted, ...extra], memberRoutes: [] },
  );
  const stops: (() => void | Promise<void>)[] = [];
  const port = (plugin: Manifest = carrierPlugin() as unknown as Manifest) =>
    carrierListenerPort({
      manifest: plugin,
      dispatcher: () => dispatcher,
      daemonId: DAEMON,
      onStop: fn => void stops.push(fn),
    });
  return { asked, attached, stops, port, owner, shared: port() };
}

const open: CarrierListenerHandle[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function listen(
  fixture: ReturnType<typeof world>,
  surface: { socket: string; peer?: (headers: ReadonlyMap<string, string>) => string } = { socket: ROUTE },
  carrier: CarrierKey = 'tunnel' as CarrierKey,
) {
  const handle = await fixture.shared.open({ carrier, surface });
  open.push(handle);
  return handle;
}

/** Dials the upgrade as `cloudflared` would: a loopback WebSocket, optionally carrying the edge's address header. */
function dial(port: number, path = PATH, headers: Record<string, string> = {}): Promise<'open' | 'refused'> {
  return new Promise(resolve => {
    const socketClient = new WebSocket(`ws://127.0.0.1:${String(port)}${path}`, { headers } as never);
    socketClient.onopen = () => {
      socketClient.close();
      resolve('open');
    };
    socketClient.onerror = () => resolve('refused');
  });
}

describe('G15 G16 R625 the carrier listener: relayed loopback is remote', () => {
  test('G15 a loopback upgrade is admitted as a carried arrival on the named carrier, never as local', async () => {
    const fixture = world();
    const handle = await listen(fixture, {
      socket: ROUTE,
      peer: headers => headers.get('cf-connecting-ip') ?? 'tunnel',
    });

    expect(await dial(handle.port, PATH, { 'cf-connecting-ip': '203.0.113.9' })).toBe('open');

    expect(fixture.asked).toHaveLength(1);
    expect(fixture.asked[0]?.arrival).toEqual(CARRIED);
    expect(fixture.asked[0]?.arrival.kind).not.toBe('local');
    expect(fixture.asked[0]?.clientAddress).toBe('203.0.113.9');
    expect(fixture.attached).toEqual([PATH]);
  });

  test('G15 nothing the caller sends makes it local: a loopback Host, a forwarded-for and an origin change nothing', async () => {
    const fixture = world();
    const handle = await listen(fixture);

    await dial(handle.port, PATH, {
      host: '127.0.0.1',
      'x-forwarded-for': '127.0.0.1',
      origin: 'http://127.0.0.1',
      'x-ferretry-local': 'true',
    });

    expect(fixture.asked[0]?.arrival).toEqual(CARRIED);
    // The listener never reads the socket's own peer (it is the forwarder): without a peer function every arrival
    // shares ONE identity, so hiding the header buys no bucket of one's own.
    expect(fixture.asked[0]?.clientAddress).toBe(CARRIER_SHARED_PEER);
  });

  test('G16 R625 every other path and method on the port is 404, and admission is never asked', async () => {
    const fixture = world();
    const handle = await listen(fixture);
    const base = `http://127.0.0.1:${String(handle.port)}`;

    const answers = await Promise.all([
      fetch(`${base}${PATH}`), // the declared path without an upgrade
      fetch(`${base}${PATH}`, { method: 'POST' }),
      fetch(`${base}/v1/health`),
      fetch(`${base}/v1/carriers`),
      fetch(`${base}/`),
      fetch(`${base}/v1/rendezvous/fy_daemon_someone_else/client`, { headers: { upgrade: 'websocket' } }),
      fetch(`${base}/v1/health`, { headers: { upgrade: 'websocket' } }),
    ]);

    expect(answers.map(answer => answer.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect(await answers[0]?.json()).toEqual({ error: 'nothing is served at this path', code: 'not_found' });
    expect(fixture.asked).toEqual([]);
    expect(await dial(handle.port, '/v1/health')).toBe('refused');
    expect(await dial(handle.port, '/v1/rendezvous/fy_daemon_someone_else/client')).toBe('refused');
    expect(fixture.asked).toEqual([]);
  });

  test('G16 a socket another plugin owns is not served here, even where it shadows the declared one', async () => {
    const shadow: MountedSocket = {
      ...declared,
      precedence: 1,
      owner: world().owner('someone'),
      accept: async () => async () => ({
        open: async () => undefined,
        fromClient: () => undefined,
        close: () => undefined,
      }),
    };
    const fixture = world([shadow]);
    const handle = await listen(fixture);

    expect(await dial(handle.port)).toBe('refused');
    expect(fixture.asked).toEqual([]);
  });

  test('admission governs the arrival: a refusal is answered and nothing is attached', async () => {
    const fixture = world([], true);
    const handle = await listen(fixture);

    expect(await dial(handle.port)).toBe('refused');

    expect(fixture.asked).toHaveLength(1);
    expect(fixture.asked[0]?.arrival).toEqual(CARRIED);
    expect(fixture.attached).toEqual([]);
  });
});

describe('who may open a carrier listener', () => {
  test('a carrier the plugin does not take is refused', async () => {
    const fixture = world();
    await expect(fixture.port().open({ carrier: 'relay' as CarrierKey, surface: { socket: ROUTE } })).rejects.toThrow(
      /does not declare the relay carrier/,
    );
    expect(fixture.stops).toHaveLength(0);
  });

  test('a socket the manifest does not declare is refused', async () => {
    const fixture = world();
    await expect(
      fixture.port().open({ carrier: 'tunnel' as CarrierKey, surface: { socket: 'GET /v1/health' } }),
    ).rejects.toThrow(/does not declare the socket GET \/v1\/health/);
  });

  test('a plugin that takes no carrier at all is refused', async () => {
    const fixture = world();
    const none = definePlugin({
      id: 'nocarrier',
      title: 'No carrier',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      actions: { sockets: [declared] },
    });
    await expect(
      fixture.port(none as unknown as Manifest).open({ carrier: 'tunnel' as CarrierKey, surface: { socket: ROUTE } }),
    ).rejects.toThrow(/does not declare the tunnel carrier/);
  });
});

describe('closing', () => {
  test('close() releases the port, and closing twice is harmless', async () => {
    const fixture = world();
    const handle = await listen(fixture);
    const { port } = handle;
    expect(await dial(port)).toBe('open');

    await handle.close();
    await handle.close();

    expect(await dial(port)).toBe('refused');
    // The address is free again: this process can bind it.
    const rebound = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('ok') });
    expect(rebound.port).toBe(port);
    await rebound.stop(true);
  });

  test('stopping the plugin closes every listener it still holds', async () => {
    const fixture = world();
    const first = await listen(fixture);
    const second = await listen(fixture);
    expect(first.port).not.toBe(second.port);
    expect(fixture.stops).toHaveLength(1);

    for (const stop of fixture.stops) await stop();

    expect(await dial(first.port)).toBe('refused');
    expect(await dial(second.port)).toBe('refused');
  });
});
