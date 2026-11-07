import { describe, expect, test } from 'bun:test';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '../../../../../core/kernel/testing/host.ts';
import { anonymous, device } from '../../../../../core/kernel/testing/admission.ts';
import { ConnectionsPort, PublishedCarriersSchema } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { buildConnections, type ConnectionBindings } from '../../../daemon/index.ts';
import { decideAdvertisement } from '../../../daemon/lib/runtime/advertisement.ts';
const identity = {
  daemonId: 'fy_daemon_' + 'a'.repeat(43),
  signClaim: async () => ({ publicKeySpki: new Uint8Array(44), signature: new Uint8Array(64) }),
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
