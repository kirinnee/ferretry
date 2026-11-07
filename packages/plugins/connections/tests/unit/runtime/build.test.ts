import { describe, expect, test } from 'bun:test';
import type { KernelPorts, SessionLayer, WebSocketPort } from '@ferretry/kernel/contract';
import { restrictWebSocket } from '../../../../../core/kernel/host/permissions.ts';
import { RelayCarrier } from '../../../daemon/adapters/relay/bun-relay-carrier.ts';
import { DaemonRelayConfigSchema } from '../../../daemon/lib/runtime/relay-config.ts';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '../../../../../core/kernel/testing/host.ts';
import { anonymous, device } from '../../../../../core/kernel/testing/admission.ts';
import {
  CarriersViewSchema,
  ConnectionsPort,
  type PublishedCarriers,
  PublishedCarriersSchema,
} from '../../../contract/index.ts';
import { publishedConnectionMethods } from '../../../app/lib/connection.ts';
import type { RelayWebSocket } from '../../../daemon/adapters/relay/bun-relay-carrier.ts';
import { FakeSessions } from '../../support/sessions.ts';
import manifest from '../../../manifest.ts';
import { buildConnections, type ConnectionBindings, kernelConnectionBindings } from '../../../daemon/index.ts';
import { decideAdvertisement } from '../../../daemon/lib/runtime/advertisement.ts';
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
      config: { 'connections.yaml': { relay: { url: 'https://mine.example' } } },
    });
    await host.runJob('relay-discovery');
    expect(host.provided(ConnectionsPort).advertisement()).toEqual({
      advertisement: { kind: 'address', url: 'http://box.example:7431', origin: 'derived' },
      port: 7431,
    });
    await host.stop();
  });
  test('R173 a switched-off discovery entry stays off', async () => {
    const host = await testHost({
      plugins: [plugin],
      config: { 'connections.yaml': { relay: { source: 'discovery', enabled: false } } },
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
    config: { 'connections.yaml': { relay: { url: 'https://mine.example', enabled: false } } },
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
  const ownRelay = { 'connections.yaml': { relay: { url: 'https://mine.example' } } };
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
describe('the default relay dial through the Kernel’s restricted WebSocket port', () => {
  /** The production bindings over a Kernel whose WebSocket port is the real manifest-restricted one. */
  function restricted() {
    const dials: string[] = [];
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
    const kernel = {
      config: { file: () => undefined },
      identity: { daemonId: identity.daemonId },
      signer: { sign: identity.sign },
      websocket: restrictWebSocket(manifest.id, manifest.permissions?.network ?? [], base),
    } as unknown as KernelPorts;
    const production = kernelConnectionBindings(kernel);
    const carrier = new RelayCarrier({
      // An explicit relay block: it resolves without discovery, so the missing discovery binding is not in play.
      config: DaemonRelayConfigSchema.parse({ url: 'https://relay.example' }),
      identity: production.identity,
      scheduler: { after: () => ({ cancel: () => undefined }) },
      now: () => 0,
      random: () => 0,
      socketFactory: production.socketFactory!,
    });
    return { dials, carrier };
  }
  // KNOWN GAP, blocked on kernel runtime relay host permission (review finding 2): the manifest declares only
  // stun.cloudflare.com, and restrictWebSocket refuses every other host before its adapter runs, so a configured or
  // discovered relay is never dialled. This pins today's refusal; it flips when the kernel admits validated runtime
  // relay endpoints, and the skipped test below is then un-skipped.
  test('known gap: a configured relay is refused by the restricted WebSocket port before any dial', async () => {
    const { dials, carrier } = restricted();
    await expect(carrier.start(new FakeSessions(), new AbortController().signal)).rejects.toThrow(
      'connections may not reach relay.example: its manifest does not declare it',
    );
    expect(dials).toEqual([]);
  });
  // blocked on kernel runtime relay host permission (review finding 2): un-skip once the kernel ships it.
  test.skip('blocked on kernel: a configured relay is dialled through the restricted WebSocket port', async () => {
    const { dials, carrier } = restricted();
    await carrier.start(new FakeSessions(), new AbortController().signal);
    expect(dials).toHaveLength(1);
    expect(new URL(dials[0]!).hostname).toBe('relay.example');
  });
});
