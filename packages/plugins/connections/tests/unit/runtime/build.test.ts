import { describe, expect, test } from 'bun:test';
import type { SessionLayer, WebSocketPort } from '@ferretry/kernel/contract';
import { restrictWebSocket } from '../../../../../core/kernel/host/permissions.ts';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '../../../../../core/kernel/testing/host.ts';
import { anonymous, device, owner } from '../../../../../core/kernel/testing/admission.ts';
import {
  CarriersViewSchema,
  ConnectionsConfigSchema,
  ConnectionsPort,
  MAX_PUBLISHED_CARRIERS,
  HOSTED_APP_ORIGIN,
  HOSTED_RELAY_DIRECTORY_ORIGIN,
  type PublishedCarriers,
  PublishedCarriersSchema,
} from '../../../contract/index.ts';
import { publishedConnectionMethods } from '../../../app/lib/connection.ts';
import type { RelayWebSocket } from '../../../daemon/adapters/relay/bun-relay-carrier.ts';
import { FakeSessions } from '../../support/sessions.ts';
import manifest from '../../../manifest.ts';
import { buildConnections, type ConnectionBindings, kernelConnectionBindings } from '../../../daemon/index.ts';
import { decideAdvertisement } from '../../../daemon/lib/runtime/advertisement.ts';
import { PAIRING_REACH_NOTICE } from '../../../daemon/lib/relay/discovery.ts';
const identity = {
  daemonId: 'fy_daemon_' + 'a'.repeat(43),
  sign: async () => ({ daemonId: 'fy_daemon_' + 'a'.repeat(43), publicKey: 'A'.repeat(59), signature: 'A'.repeat(86) }),
};
const bindings: ConnectionBindings = {
  identity,
  openSession: (layer, key, peer) => layer.open(key, peer),
  directUrl: 'https://box.example',
  host: 'box.example',
  port: 7431,
};
const plugin = implementDaemon(manifest, { build: ctx => buildConnections(ctx, bindings) });
describe('published carrier route', () => {
  test('P35 the port and refresh route read the same parsed published set', async () => {
    const host = await testHost({ plugins: [plugin] });
    await host.runJob('relay-discovery');
    const response = await host.request('GET', '/v1/carriers', { as: device('phone') });
    expect(response.json()).toEqual({ carriers: host.provided(ConnectionsPort).carriers() });
    await host.stop();
  });
  test('P36 the published schema refuses a daemon fingerprint', () => {
    expect(
      PublishedCarriersSchema.safeParse([{ kind: 'direct', url: 'https://box.example', daemonId: identity.daemonId }])
        .success,
    ).toBe(false);
  });
  test('P47 paired callers may refresh without a pairing capability', async () => {
    const host = await testHost({ plugins: [plugin] });
    const answer = await host.request('GET', '/v1/carriers', { as: device('phone', []) });
    expect(answer.status).toBe(200);
    await host.stop();
  });
  test('P48 carrier refresh is marked no-store', () => {
    expect(manifest.actions.routes.find(r => r.key === 'GET /v1/carriers')?.noStore).toBe(true);
  });
  test('P49 carrier refresh is neither privileged nor capability-gated', () => {
    const route = manifest.actions.routes.find(r => r.key === 'GET /v1/carriers')!;
    expect('privilegedOnly' in route).toBe(false);
    expect('capability' in route).toBe(false);
  });
  test('P50 a device cannot mutate the published carrier set', async () => {
    const host = await testHost({ plugins: [plugin] });
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await host.request(method, '/v1/carriers', { as: device('phone') })).status).toBe(405);
    }
    await host.stop();
  });
  test('P52 an anonymous caller cannot read the published carrier set', async () => {
    const host = await testHost({ plugins: [plugin] });
    expect((await host.request('GET', '/v1/carriers', { as: anonymous() })).status).toBe(401);
    await host.stop();
  });
  test('R189 the carrier wire refuses a privilege field', () => {
    expect(
      PublishedCarriersSchema.safeParse([{ kind: 'direct', url: 'https://box.example', privileged: true }]).success,
    ).toBe(false);
  });
  test('R190 the carrier wire refuses an unknown kind or key', () => {
    for (const carrier of [
      { kind: 'direct', url: 'https://box.example', extra: true },
      { kind: 'magic', url: 'https://box.example' },
    ])
      expect(PublishedCarriersSchema.safeParse([carrier]).success).toBe(false);
  });
  test('P82 a configured relay is never disclosed as a hosted discovered relay', async () => {
    const host = await testHost({
      plugins: [plugin],
      config: { 'connections.yaml': { relay: [{ url: 'https://mine.example' }] } },
    });
    await host.runJob('relay-discovery');
    expect(host.provided(ConnectionsPort).advertisement()).toEqual({
      advertisement: { kind: 'address', url: 'http://box.example:7431', origin: 'derived' },
      port: 7431,
      appOrigin: HOSTED_APP_ORIGIN,
      allowedOrigins: [HOSTED_APP_ORIGIN, 'http://box.example:7431'],
      directoryOrigin: HOSTED_RELAY_DIRECTORY_ORIGIN,
    });
    await host.stop();
  });
  test('the advertisement names the app origin, the browser origins and the directory from the same facts as the QR', async () => {
    const custom = implementDaemon(manifest, {
      build: ctx =>
        buildConnections(ctx, {
          ...bindings,
          publicUrl: 'https://fy.example.org/',
          corsOrigins: ['https://app.example', HOSTED_APP_ORIGIN],
          directoryOrigin: 'https://directory.example',
        }),
    });
    const host = await testHost({ plugins: [custom] });
    await host.runJob('relay-discovery');
    const advertised = host.provided(ConnectionsPort).advertisement();
    expect(advertised.appOrigin).toBe(HOSTED_APP_ORIGIN);
    expect(advertised.allowedOrigins).toEqual([
      'https://app.example',
      HOSTED_APP_ORIGIN,
      'https://fy.example.org',
      'http://box.example:7431',
    ]);
    expect(advertised.directoryOrigin).toBe('https://directory.example');
    await host.stop();
    // A build with no directory (`off`) names none.
    const off = implementDaemon(manifest, {
      build: ctx =>
        buildConnections(ctx, {
          ...bindings,
          directoryOrigin: 'off',
          directory: { read: async () => ({ kind: 'undetermined', reason: 'off' }) } as never,
        }),
    });
    const offHost = await testHost({ plugins: [off] });
    expect(offHost.provided(ConnectionsPort).advertisement().directoryOrigin).toBeUndefined();
    await offHost.stop();
  });
  test('R173 a switched-off discovery entry stays off', async () => {
    const host = await testHost({
      plugins: [plugin],
      config: { 'connections.yaml': { relay: [{ source: 'discovery', enabled: false }] } },
    });
    await host.runJob('relay-discovery');
    expect(host.provided(ConnectionsPort).carriers()).toEqual([{ kind: 'direct', url: 'https://box.example' }]);
    await host.stop();
  });
  test('P88 wildcard binds never manufacture an advertised foreign address', () => {
    for (const host of ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0']) {
      expect(decideAdvertisement({ host, port: 7431 })).toEqual({ kind: 'none', refusal: 'wildcard-bind' });
    }
  });
});

test('P82 only hosted-directory provenance is disclosed to Access', async () => {
  const withDirectory = implementDaemon(manifest, {
    build: ctx =>
      buildConnections(ctx, {
        ...bindings,
        directory: { read: async () => ({ kind: 'available', relayUrl: 'https://hosted.example' }) },
      }),
  });
  const host = await testHost({ plugins: [withDirectory] });
  await host.runJob('relay-discovery');
  expect(host.provided(ConnectionsPort).advertisement().discoveredRelayUrl).toBe('https://hosted.example');
  await host.stop();
});
test('R213 directory discovery runs once per boot even when the start job is retried', async () => {
  let reads = 0;
  const withDirectory = implementDaemon(manifest, {
    build: ctx =>
      buildConnections(ctx, {
        ...bindings,
        directory: {
          read: async () => {
            reads++;
            return { kind: 'available', relayUrl: 'https://hosted.example' };
          },
        },
      }),
  });
  const host = await testHost({ plugins: [withDirectory] });
  await host.runJob('relay-discovery');
  await host.runJob('relay-discovery');
  expect(reads).toBe(1);
  await host.stop();
});
test('an empty relay list keeps today’s hosted discovery default', async () => {
  const withDirectory = implementDaemon(manifest, {
    build: ctx =>
      buildConnections(ctx, {
        ...bindings,
        directory: { read: async () => ({ kind: 'available', relayUrl: 'https://hosted.example' }) },
      }),
  });
  const host = await testHost({ plugins: [withDirectory], config: { 'connections.yaml': { relay: [] } } });
  await host.runJob('relay-discovery');
  expect(host.provided(ConnectionsPort).carriers()).toEqual([
    { kind: 'direct', url: 'https://box.example' },
    { kind: 'relay', url: 'https://hosted.example' },
  ]);
  await host.stop();
});
test('a configured/discovered collision refuses the list before either relay dials', async () => {
  let half: ReturnType<typeof buildConnections> | undefined;
  const dials: string[] = [];
  const collision = implementDaemon(manifest, {
    build: ctx => {
      half = buildConnections(ctx, {
        ...bindings,
        directory: { read: async () => ({ kind: 'available', relayUrl: 'https://same.example' }) },
        socketFactory: url => {
          dials.push(url);
          throw new Error('no dial should occur');
        },
      });
      return half;
    },
  });
  const host = await testHost({
    plugins: [collision],
    config: { 'connections.yaml': { relay: [{ source: 'discovery' }, { url: 'https://same.example' }] } },
  });
  await expect(half!.hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal)).rejects.toThrow(
    'same',
  );
  expect(dials).toEqual([]);
  expect(half!.resolvers.relay()).toEqual([]);
  await host.stop();
});
test('R14 a withdrawal at runtime takes effect at the next boot without an app release', async () => {
  let disabled = false;
  const withDirectory = implementDaemon(manifest, {
    build: ctx =>
      buildConnections(ctx, {
        ...bindings,
        directory: {
          read: async () =>
            disabled ? { kind: 'disabled' } : { kind: 'available', relayUrl: 'https://hosted.example' },
        },
      }),
  });
  const host = await testHost({ plugins: [withDirectory] });
  await host.runJob('relay-discovery');
  expect(
    host
      .provided(ConnectionsPort)
      .carriers()
      .some(c => c.kind === 'relay'),
  ).toBe(true);
  disabled = true;
  const rebooted = await host.restart();
  await rebooted.runJob('relay-discovery');
  expect(
    rebooted
      .provided(ConnectionsPort)
      .carriers()
      .some(c => c.kind === 'relay'),
  ).toBe(false);
  await rebooted.stop();
});
test('a daemon without its identity binding refuses rather than claiming carriers it cannot serve', async () => {
  const pending = implementDaemon(manifest, { build: ctx => buildConnections(ctx) });
  const host = await testHost({ plugins: [pending] });
  expect((await host.request('GET', '/v1/carriers', { as: device('phone') })).status).toBe(503);
  expect(() => host.provided(ConnectionsPort).advertisement()).toThrow();
  await host.stop();
});
test('R206 a discovery failure on a loopback bind says the consequence and the remedy in the boot trail', async () => {
  let half: ReturnType<typeof buildConnections> | undefined;
  const undetermined = implementDaemon(manifest, {
    build: ctx =>
      (half = buildConnections(ctx, {
        ...bindings,
        host: '127.0.0.1',
        directory: { read: async () => ({ kind: 'undetermined', reason: 'the relay directory is unavailable' }) },
      })),
  });
  const host = await testHost({ plugins: [undetermined] });
  // The kernel starts every carrier at boot; the relay carrier is the one that waits for discovery.
  await half!.hooks['carriers:relay'].start({} as SessionLayer, new AbortController().signal);
  const trail = host.logs.map(entry => entry.message);
  expect(trail[0]).toBe('no relay carrier — no relay could be discovered: the relay directory is unavailable');
  expect(trail[1]).toContain('bound to 127.0.0.1 and dials no relay, so NO other device can reach it');
  expect(trail[2]).toContain('to pair: set "host" to "0.0.0.0"');
  expect(trail[3]).toContain('a restart asks the relay directory again');
  expect(trail).toHaveLength(4);
  expect(host.provided(ConnectionsPort).carriers()).toEqual([{ kind: 'direct', url: 'https://box.example' }]);
  await host.stop();
});
test('R206 a relay switched off in the configuration names that switch once, with its remedy', async () => {
  let half: ReturnType<typeof buildConnections> | undefined;
  const switchedOff = implementDaemon(manifest, { build: ctx => (half = buildConnections(ctx, bindings)) });
  const host = await testHost({
    plugins: [switchedOff],
    config: { 'connections.yaml': { relay: [{ url: 'https://mine.example', enabled: false }] } },
  });
  await half!.hooks['carriers:relay'].start({} as SessionLayer, new AbortController().signal);
  const trail = host.logs.map(entry => entry.message);
  expect(trail.filter(line => line.startsWith('no relay carrier — '))).toEqual([
    "no relay carrier — the configured relay https://mine.example is switched off in this daemon's configuration",
  ]);
  expect(trail.some(line => line.includes('reachable only from this machine’s own network'))).toBe(true);
  expect(trail.some(line => line.includes('is what this daemon dials — correct it or remove it'))).toBe(true);
  await host.stop();
});
describe('the carrier set is the daemon’s answer', () => {
  const ownRelay = { 'connections.yaml': { relay: [{ url: 'https://mine.example' }] } };
  test('R4 which carriers a daemon holds is its own answer: nothing a browser sends changes the set', async () => {
    const host = await testHost({ plugins: [plugin], config: ownRelay });
    await host.runJob('relay-discovery');
    const daemonSet: PublishedCarriers = [
      { kind: 'direct', url: 'https://box.example' },
      { kind: 'relay', url: 'https://mine.example' },
    ];
    const queries: Record<string, string>[] = [{}, { kind: 'relay', url: 'https://evil.example' }, { carriers: '[]' }];
    for (const query of queries)
      for (const caller of [device('phone'), device('laptop', [])])
        expect(
          (await host.request('GET', '/v1/carriers', { as: caller, query, headers: { 'x-carriers': 'relay' } })).json(),
        ).toEqual({ carriers: daemonSet });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect((await host.request(method, '/v1/carriers', { as: device('phone'), body: { carriers: [] } })).status).toBe(
        405,
      );
    expect(host.provided(ConnectionsPort).carriers()).toEqual(daemonSet);
    await host.stop();
  });
  test('R188 the daemon fingerprint is in no published carrier and no carrier diagnostic', async () => {
    const dialled: string[] = [];
    const sockets: RelayWebSocket[] = [];
    let half: ReturnType<typeof buildConnections> | undefined;
    const relayed = implementDaemon(manifest, {
      build: ctx =>
        (half = buildConnections(ctx, {
          ...bindings,
          socketFactory: url => {
            dialled.push(url);
            const socket: RelayWebSocket = {
              binaryType: '',
              onopen: null,
              onmessage: null,
              onclose: null,
              onerror: null,
              send: () => undefined,
              close: () => undefined,
            };
            sockets.push(socket);
            return socket;
          },
        })),
    });
    const host = await testHost({ plugins: [relayed], config: ownRelay });
    await host.runJob('relay-discovery');
    await half!.hooks['carriers:relay'].start(new FakeSessions(), new AbortController().signal);
    sockets[0]!.onopen?.(undefined);
    sockets[0]!.onclose?.({ code: 4401, reason: 'the claim was rejected' });
    // The rendezvous path carries the fingerprint (that is how it is addressed) — and nothing said about it does.
    expect(dialled[0]).toContain(identity.daemonId);
    const carriers = await host.request('GET', '/v1/carriers', { as: device('phone') });
    expect(carriers.body).not.toContain(identity.daemonId);
    expect(JSON.stringify(host.provided(ConnectionsPort).carriers())).not.toContain(identity.daemonId);
    expect(JSON.stringify(half!.hooks['carriers:relay'].status())).not.toContain(identity.daemonId);
    expect(host.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(host.logs)).not.toContain(identity.daemonId);
    expect(JSON.stringify(host.logs)).not.toContain('a'.repeat(43));
    await host.stop();
  });
  test('R192 the daemon’s published body is read by the app through the one contract shape', async () => {
    const host = await testHost({ plugins: [plugin], config: ownRelay });
    await host.runJob('relay-discovery');
    const body = (await host.request('GET', '/v1/carriers', { as: device('phone') })).json();
    // `app/index.ts` parses the refresh with CarriersViewSchema; the daemon publishes through PublishedCarriersSchema.
    expect(CarriersViewSchema.shape.carriers).toBe(PublishedCarriersSchema);
    const parsed = CarriersViewSchema.parse(body);
    expect(parsed.carriers).toEqual(host.provided(ConnectionsPort).carriers());
    expect(publishedConnectionMethods(parsed.carriers)).toEqual([
      { kind: 'direct', daemonUrl: 'https://box.example' },
      { kind: 'relay', relayUrl: 'https://mine.example', operator: 'self' },
    ]);
    await host.stop();
  });
});
describe('the default relay dial through the Kernel restricted WebSocket port', () => {
  async function restricted(relay: unknown, directory?: ConnectionBindings['directory']) {
    const dials: string[] = [];
    let half: ReturnType<typeof buildConnections> | undefined;
    let websocket: WebSocketPort | undefined;
    const base: WebSocketPort = {
      connect: url => {
        dials.push(String(url));
        return {
          binaryType: '',
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send: () => undefined,
          close: () => undefined,
        } as unknown as ReturnType<WebSocketPort['connect']>;
      },
    };
    const production = implementDaemon(manifest, {
      build: ctx => {
        websocket = restrictWebSocket(manifest.id, manifest.permissions.network, base, undefined, name =>
          name === 'relay' ? half?.resolvers.relay : undefined,
        );
        const kernel = { ...ctx.kernel, websocket };
        half = buildConnections(
          { ...ctx, kernel },
          {
            ...kernelConnectionBindings(kernel),
            ...(directory === undefined ? {} : { directory }),
          },
        );
        return half;
      },
    });
    const host = await testHost({ plugins: [production], config: { 'connections.yaml': { relay } } });
    const controller = new AbortController();
    await half!.hooks['carriers:relay'].start(new FakeSessions(), controller.signal);
    return {
      host,
      half: half!,
      dials,
      websocket: websocket!,
      stop: async () => {
        controller.abort();
        await host.stop();
      },
    };
  }
  test('a configured relay is dialled through the real restricted WebSocket port', async () => {
    const h = await restricted([{ url: 'https://relay.example:8443' }]);
    expect(h.dials).toHaveLength(1);
    expect(new URL(h.dials[0]!).host).toBe('relay.example:8443');
    expect(h.half.resolvers.relay()).toEqual(['relay.example:8443']);
    expect(() => h.websocket.connect('wss://relay.example:9443/other')).toThrow('manifest does not declare it');
    expect(() => h.websocket.connect('wss://caller.example/other')).toThrow('manifest does not declare it');
    expect(h.dials).toHaveLength(1);
    await h.stop();
  });
  test('the ordered relay list dials every enabled configured or discovered host through the resolver', async () => {
    const h = await restricted(
      [
        { url: 'https://one.example' },
        { source: 'discovery' },
        { url: 'https://off.example', enabled: false },
        { url: 'https://two.example' },
      ],
      { read: async () => ({ kind: 'available', relayUrl: 'https://hosted.example' }) },
    );
    expect(h.dials.map(url => new URL(url).host)).toEqual(['one.example', 'hosted.example', 'two.example']);
    expect(h.half.resolvers.relay()).toEqual(['one.example', 'hosted.example', 'two.example']);
    expect(h.host.provided(ConnectionsPort).carriers()).toEqual([
      { kind: 'relay', url: 'https://one.example' },
      { kind: 'relay', url: 'https://hosted.example' },
      { kind: 'relay', url: 'https://two.example' },
    ]);
    expect(() => h.websocket.connect('wss://off.example/other')).toThrow('manifest does not declare it');
    await h.stop();
  });
});

/** A build whose hosted directory advertises a relay, so the discovery entry resolves to a published relay. */
function discovering(extra: Partial<ConnectionBindings> = {}) {
  return implementDaemon(manifest, {
    build: ctx =>
      buildConnections(ctx, {
        ...bindings,
        directory: { read: async () => ({ kind: 'available', relayUrl: 'https://hosted.example' }) },
        ...extra,
      }),
  });
}

describe('the carrier set the daemon publishes (Appendix D, connections batch 3)', () => {
  test('R11 the daemon publishes its carrier set: one answer, with the discovery relay in it, to redemption and to the refresh', async () => {
    const host = await testHost({ plugins: [discovering()] });
    await host.runJob('relay-discovery');
    const expected: PublishedCarriers = [
      { kind: 'direct', url: 'https://box.example' },
      { kind: 'relay', url: 'https://hosted.example' },
    ];
    // Redemption reads the port; the refresh route reads the same set. Neither takes a set from the caller.
    expect(host.provided(ConnectionsPort).carriers()).toEqual(expected);
    const refreshed = await host.request('GET', '/v1/carriers', { as: device('phone') });
    expect(refreshed.json()).toEqual({ carriers: expected });
    await host.stop();
  });

  test('R182 nothing derived is persisted: the list is re-derived on every read and a tunnel change shows at once', async () => {
    const host = await testHost({ plugins: [discovering()] });
    await host.runJob('relay-discovery');
    const first = host.provided(ConnectionsPort).carriers();
    const again = host.provided(ConnectionsPort).carriers();
    expect(again).toEqual(first);
    await host.request('GET', '/v1/carriers', { as: device('phone') });
    // Deriving and serving the set wrote no file and no document under the plugin's state folder.
    const state = host.state('connections');
    expect(state.files.size).toBe(0);
    expect(state.bytes.size).toBe(0);
    expect(state.databases.size).toBe(0);
    await host.stop();
  });

  test('R183 the published set is at most 8 entries, in the daemon’s order: the direct address first, then the relays as written', async () => {
    const host = await testHost({
      plugins: [discovering()],
      config: {
        'connections.yaml': {
          relay: [{ url: 'https://one.example' }, { source: 'discovery' }, { url: 'https://two.example' }],
        },
      },
    });
    await host.runJob('relay-discovery');
    const set = host.provided(ConnectionsPort).carriers();
    expect(set.map(carrier => carrier.url)).toEqual([
      'https://box.example',
      'https://one.example',
      'https://hosted.example',
      'https://two.example',
    ]);
    expect(set.length).toBeLessThanOrEqual(MAX_PUBLISHED_CARRIERS);
    expect(MAX_PUBLISHED_CARRIERS).toBe(8);
    // The wire refuses a ninth entry rather than truncating it, so a device never holds a silently shortened set.
    const nine = Array.from({ length: 9 }, (_, n) => ({
      kind: 'relay' as const,
      url: `https://r${String(n)}.example`,
    }));
    expect(PublishedCarriersSchema.safeParse(nine.slice(0, 8)).success).toBe(true);
    expect(PublishedCarriersSchema.safeParse(nine).success).toBe(false);
    // Every entry is exactly `{ kind, url }`: nothing else rides on the redemption response.
    for (const carrier of set) expect(Object.keys(carrier).sort()).toEqual(['kind', 'url']);
    await host.stop();
  });

  test('R185 GET /v1/carriers is no-store, authenticated and not host-scoped: a paired device off the host reads it, a stranger cannot', async () => {
    const route = manifest.actions.routes.find(r => r.key === 'GET /v1/carriers')!;
    expect(route.minimum).toBe('authenticated');
    expect(route.noStore).toBe(true);
    expect(route.caller).toBe('any');
    const host = await testHost({ plugins: [plugin] });
    await host.runJob('relay-discovery');
    // A carried (not on-host) paired device: the answer, marked no-store.
    const carried = await host.request('GET', '/v1/carriers', { as: device('phone') });
    expect(carried.status).toBe(200);
    expect(carried.headers.get('cache-control')).toBe('no-store');
    // The host's own owner reads the same answer: the route is not scoped to one side of the host boundary.
    const owned = await host.request('GET', '/v1/carriers', { as: owner() });
    expect(owned.status).toBe(200);
    expect(owned.json()).toEqual(carried.json());
    // Nobody who proved nothing reads it.
    expect((await host.request('GET', '/v1/carriers', { as: anonymous() })).status).toBe(401);
    await host.stop();
  });

  test('R218 fy pair and fyd --check share one derivation: two reads of the advertisement agree, and a self-hosted relay is never disclosed as discovered', async () => {
    // Loopback bind + the operator's own relay: a local-only address, and nothing for a QR to be drawn from.
    const selfHosted = implementDaemon(manifest, {
      build: ctx => buildConnections(ctx, { ...bindings, host: '127.0.0.1', directUrl: 'http://127.0.0.1:7431' }),
    });
    const own = await testHost({
      plugins: [selfHosted],
      config: { 'connections.yaml': { relay: [{ url: 'https://mine.example' }] } },
    });
    await own.runJob('relay-discovery');
    const pair = own.provided(ConnectionsPort).advertisement();
    const check = own.provided(ConnectionsPort).advertisement();
    expect(check).toEqual(pair);
    expect(pair.advertisement.kind).toBe('local-only');
    expect(pair.discoveredRelayUrl).toBeUndefined();
    expect(JSON.stringify(pair)).not.toContain('mine.example');
    await own.stop();
    // The same loopback bind with the hosted directory's relay: now `fy pair` knows the daemon is redeemable.
    const hosted = await testHost({ plugins: [discovering({ host: '127.0.0.1' })] });
    await hosted.runJob('relay-discovery');
    expect(hosted.provided(ConnectionsPort).advertisement().discoveredRelayUrl).toBe('https://hosted.example');
    expect(hosted.provided(ConnectionsPort).advertisement()).toEqual(hosted.provided(ConnectionsPort).advertisement());
    await hosted.stop();
    expect(PAIRING_REACH_NOTICE).toContain('only way in');
  });

  test('R221 discoveredRelayUrl is host-facing only: it is in no published carrier answer and no fragment-shaped field', async () => {
    const host = await testHost({ plugins: [discovering()] });
    await host.runJob('relay-discovery');
    const advertised = host.provided(ConnectionsPort).advertisement();
    expect(advertised.discoveredRelayUrl).toBe('https://hosted.example');
    // The route answer is exactly `{ carriers }`, and the published schemas have no field to carry the advertisement.
    const answer = (await host.request('GET', '/v1/carriers', { as: device('phone') })).json<Record<string, unknown>>();
    expect(Object.keys(answer)).toEqual(['carriers']);
    expect(CarriersViewSchema.safeParse({ carriers: [], discoveredRelayUrl: 'https://hosted.example' }).success).toBe(
      false,
    );
    expect(
      PublishedCarriersSchema.safeParse([{ kind: 'direct', url: 'https://box.example', discoveredRelayUrl: 'x' }])
        .success,
    ).toBe(false);
    // Only a relay read from the hosted directory is ever named: a configured relay yields none (R218).
    const configured = await testHost({
      plugins: [plugin],
      config: { 'connections.yaml': { relay: [{ url: 'https://mine.example' }] } },
    });
    await configured.runJob('relay-discovery');
    expect(configured.provided(ConnectionsPort).advertisement()).not.toHaveProperty('discoveredRelayUrl');
    await configured.stop();
    await host.stop();
  });

  test('R174 the carriers document is the one spelling: first boot with no document binds loopback and records its port', async () => {
    // No document, no host: the bind is the loopback address, and the port the daemon holds is the one it records.
    const first = implementDaemon(manifest, {
      build: ctx => buildConnections(ctx, { identity, openSession: bindings.openSession, port: 7431 }),
    });
    const host = await testHost({ plugins: [first] });
    const advertised = host.provided(ConnectionsPort).advertisement();
    expect(advertised.port).toBe(7431);
    expect(advertised.advertisement).toEqual({ kind: 'local-only', url: 'http://127.0.0.1:7431' });
    await host.stop();
    // The one spelling: the old top-level `host` / `port` / `relay` keys are not read.
    for (const stray of [{ host: '0.0.0.0' }, { port: 7431 }, { relay: 'https://one.example' }]) {
      expect(ConnectionsConfigSchema.safeParse(stray).success).toBe(false);
    }
    expect(ConnectionsConfigSchema.safeParse({ direct: { host: '0.0.0.0', port: 7431 } }).success).toBe(true);
  });
});

describe('the advertisement follows the listener the kernel bound', () => {
  const unbound: ConnectionBindings = { identity, openSession: (layer, key, peer) => layer.open(key, peer) };
  const hosted = { read: async () => ({ kind: 'available', relayUrl: 'wss://hosted.example/fy' }) as const };
  const via = (bind: () => { host: string; port: number } | undefined, config?: object) =>
    testHost({
      plugins: [
        implementDaemon(manifest, {
          build: ctx =>
            buildConnections(ctx, { ...unbound, directory: hosted, ...kernelConnectionBindings(ctx.kernel) }),
        }),
      ],
      bind,
      ...(config === undefined ? {} : { config: { 'connections.yaml': config } }),
    });

  test('a loopback listener with no connections.yaml is a local-only address on the port it really bound', async () => {
    const host = await via(() => ({ host: '127.0.0.1', port: 7458 }));
    await host.runJob('relay-discovery');
    const advertised = host.provided(ConnectionsPort).advertisement();
    expect(advertised.advertisement).toEqual({ kind: 'local-only', url: 'http://127.0.0.1:7458' });
    expect(advertised.port).toBe(7458);
    expect(advertised.discoveredRelayUrl).toBe('wss://hosted.example/fy');
    expect(advertised.allowedOrigins).toEqual([HOSTED_APP_ORIGIN]);
    await host.stop();
  });

  test('the bound port wins over direct.port in the configuration, and the configuration answers only while nothing is bound', async () => {
    let bound: { host: string; port: number } | undefined;
    const host = await via(() => bound, { direct: { host: '127.0.0.1', port: 9999 } });
    await host.runJob('relay-discovery');
    expect(host.provided(ConnectionsPort).advertisement().advertisement).toEqual({
      kind: 'local-only',
      url: 'http://127.0.0.1:9999',
    });
    bound = { host: '127.0.0.1', port: 7458 };
    expect(host.provided(ConnectionsPort).advertisement().advertisement).toEqual({
      kind: 'local-only',
      url: 'http://127.0.0.1:7458',
    });
    await host.stop();
  });

  test('it is read when asked, not when built: no port before the listener binds, an address after', async () => {
    let bound: { host: string; port: number } | undefined;
    const host = await via(() => bound);
    expect(host.provided(ConnectionsPort).advertisement().advertisement).toEqual({
      kind: 'none',
      refusal: 'no-port',
    });
    bound = { host: '127.0.0.1', port: 51234 };
    expect(host.provided(ConnectionsPort).advertisement().advertisement).toEqual({
      kind: 'local-only',
      url: 'http://127.0.0.1:51234',
    });
    await host.stop();
  });

  test('a wildcard listener still refuses with wildcard-bind, whatever the configuration says', async () => {
    const host = await via(() => ({ host: '0.0.0.0', port: 7458 }), { direct: { host: '127.0.0.1', port: 7458 } });
    expect(host.provided(ConnectionsPort).advertisement().advertisement).toEqual({
      kind: 'none',
      refusal: 'wildcard-bind',
    });
    await host.stop();
  });

  describe('the browser-origin allowlist is the configuration, never the listener', () => {
    const HOSTED = [HOSTED_APP_ORIGIN];
    const origins = async (bound: { host: string; port: number } | undefined, config?: object) => {
      const host = await via(() => bound, config);
      const allowed = host.provided(ConnectionsPort).advertisement().allowedOrigins;
      await host.stop();
      return allowed;
    };
    test.each([
      ['a loopback listener', { host: '127.0.0.1', port: 7458 }],
      ['a wildcard listener', { host: '0.0.0.0', port: 7458 }],
      ['a concrete listener', { host: '192.0.2.7', port: 7458 }],
      ['an ephemeral port', { host: '127.0.0.1', port: 51234 }],
    ])('with no direct block, %s adds nothing to the hosted origin', async (_name, bound) => {
      expect(await origins(bound)).toEqual(HOSTED);
    });
    test.each([
      ['loopback', { host: '127.0.0.1', port: 7458 }],
      ['wildcard', { host: '0.0.0.0', port: 7458 }],
      ['concrete', { host: '192.0.2.7', port: 7458 }],
    ])('a direct block that matches the %s listener is unchanged', async (_name, bound) => {
      expect(await origins(bound, { direct: { host: bound.host, port: bound.port } })).toEqual([
        ...HOSTED,
        `http://${bound.host}:${String(bound.port)}`,
      ]);
    });
    test('a direct block that differs from the listener is what stays allowed, not the listener', async () => {
      expect(await origins({ host: '127.0.0.1', port: 7458 }, { direct: { host: '192.0.2.7', port: 9999 } })).toEqual([
        ...HOSTED,
        'http://192.0.2.7:9999',
      ]);
    });
  });
});
