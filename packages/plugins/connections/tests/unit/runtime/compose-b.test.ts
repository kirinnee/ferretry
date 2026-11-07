/**
 * The REAL daemon half (default export) in the kernel's test host, answering every tunnel and WebRTC route the
 * manifest declares — through kernel ports only, with a fake for Cloudflare's hosted service and for the peer.
 */
import { describe, expect, test } from 'bun:test';
import type { Carrier } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { anonymous, device, owner } from '../../../../../core/kernel/testing/admission.ts';
import { testHost } from '../../../../../core/kernel/testing/host.ts';
import { TUNNEL_OFF_SENTENCE, TunnelStatusViewSchema } from '../../../contract/index.ts';
import daemon, { buildConnections, kernelConnectionBindings } from '../../../daemon/index.ts';
import { webrtcArrival } from '../../../daemon/lib/webrtc/carrier.ts';
import manifest from '../../../manifest.ts';
import { FakeSessions } from '../../support/sessions.ts';

const SDP = 'v=0\r\ns=-\r\na=fingerprint:sha-256 SDP-MARKER\r\n';

/** The default half, but every outbound call and spawn is a hard failure: nothing here may reach Cloudflare. */
const noWorld = {
  fetch: (url: URL): never => {
    throw new Error(`no real network in a composition test: ${url.host}`);
  },
  spawn: (program: string): never => {
    throw new Error(`no real child in a composition test: ${program}`);
  },
};

describe('connections daemon half: tunnel and WebRTC composed', () => {
  test('every declared tunnel and webrtc route reaches its real handler, not plugin_unavailable', async () => {
    const host = await testHost({ plugins: [daemon], ...noWorld });
    const status = await host.request('GET', '/v1/tunnel', { as: device('phone') });
    expect(status.status).toBe(200);
    expect(TunnelStatusViewSchema.parse(status.json())).toMatchObject({ enabled: false, state: 'off' });
    // A device that is not inside a session page-lifetime is told so by the REAL offer handler (a stub says 503).
    const offer = await host.request('POST', '/v1/webrtc/offer', { as: device('phone'), body: { sdp: SDP } });
    expect(offer.status).toBe(403);
    expect(offer.json<{ code: string }>().code).toBe('webrtc_device_only');
    await host.stop();
  });

  test('PUT /v1/tunnel is the real switch: the owner may turn it on, a paired device without the capability may not', async () => {
    const host = await testHost({ plugins: [daemon], ...noWorld });
    const refused = await host.request('PUT', '/v1/tunnel', { as: device('phone', []), body: { enabled: true } });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).not.toBe(503);
    const invalid = await host.request('PUT', '/v1/tunnel', { as: owner(), body: { enabled: 'yes' } });
    expect(invalid.status).toBe(400);
    expect(invalid.json<{ code: string }>().code).toBe('invalid_request');
    await host.stop();
  });

  test('an unauthenticated caller reaches neither route', async () => {
    const host = await testHost({ plugins: [daemon], ...noWorld });
    expect((await host.request('GET', '/v1/tunnel', { as: anonymous() })).status).toBe(401);
    expect((await host.request('POST', '/v1/webrtc/offer', { as: anonymous(), body: { sdp: SDP } })).status).toBe(401);
    await host.stop();
  });

  test('the carriers hooks are the real tunnel and WebRTC carriers, off until asked', async () => {
    let half: ReturnType<typeof buildConnections> | undefined;
    const plugin = implementDaemon(manifest, {
      build: ctx => (half = buildConnections(ctx, kernelConnectionBindings(ctx.kernel))),
    });
    const host = await testHost({ plugins: [plugin], ...noWorld });
    const controller = new AbortController();
    const tunnel = half!.hooks['carriers:tunnel'] as Carrier;
    const webrtc = half!.hooks['carriers:webrtc'] as Carrier;
    await tunnel.start(new FakeSessions(), controller.signal);
    await webrtc.start(new FakeSessions(), controller.signal);
    expect(tunnel.status()).toEqual({ state: 'off', sentence: TUNNEL_OFF_SENTENCE });
    expect(webrtc.status().state).toBe('ready');
    controller.abort();
    await host.stop();
  });

  test('a switched-off WebRTC carrier answers webrtc_disabled and starts nothing', async () => {
    const host = await testHost({
      plugins: [daemon],
      ...noWorld,
      config: { 'connections.yaml': { webrtc: { enabled: false } } },
    });
    const offer = await host.request('POST', '/v1/webrtc/offer', { as: device('phone'), body: { sdp: SDP } });
    expect(offer.status).toBe(403);
    await host.stop();
  });

  test('G15 a WebRTC arrival is remote, never loopback', () => {
    const arrival = webrtcArrival('peer-1');
    expect(arrival).toEqual({ kind: 'carried', carrier: 'webrtc', address: 'webrtc-peer:peer-1' });
  });

  test('a tunnel switched on without a cloudflared or a listener says so and runs no child, no fetch', async () => {
    let half: ReturnType<typeof buildConnections> | undefined;
    const plugin = implementDaemon(manifest, {
      build: ctx => (half = buildConnections(ctx, kernelConnectionBindings(ctx.kernel))),
    });
    const host = await testHost({
      plugins: [plugin],
      ...noWorld,
      config: { 'connections.yaml': { tunnel: { enabled: true } } },
    });
    const controller = new AbortController();
    const tunnel = half!.hooks['carriers:tunnel'] as Carrier;
    await tunnel.start(new FakeSessions(), controller.signal);
    await host.clock.advance(1);
    const view = TunnelStatusViewSchema.parse(
      (await host.request('GET', '/v1/tunnel', { as: device('phone') })).json(),
    );
    expect(view).toMatchObject({ enabled: true, explicit: true, state: 'unavailable' });
    expect(tunnel.status().state).toBe('failed');
    expect(host.published.filter(p => p.event === 'CarriersChanged')).toEqual([]);
    controller.abort();
    await host.stop();
  });

  test('a tunnel with a located cloudflared asks the hosted service and, when it is off, opens no listener', async () => {
    let listened = 0;
    let asked = 0;
    let half: ReturnType<typeof buildConnections> | undefined;
    const plugin = implementDaemon(manifest, {
      build: ctx =>
        (half = buildConnections(ctx, kernelConnectionBindings(ctx.kernel), undefined, {
          cloudflared: { locate: () => ({ kind: 'found', path: '/bin/cloudflared', via: 'path' }) },
          openListener: async () => {
            listened += 1;
            return { port: 4040, close: async () => {} };
          },
        })),
    });
    const host = await testHost({
      plugins: [plugin],
      spawn: noWorld.spawn,
      fetch: () => {
        asked += 1;
        return new Response('{}', { status: 404 });
      },
      config: { 'connections.yaml': { tunnel: { enabled: true } } },
    });
    const controller = new AbortController();
    await (half!.hooks['carriers:tunnel'] as Carrier).start(new FakeSessions(), controller.signal);
    await host.clock.advance(1);
    expect(asked).toBeGreaterThan(0);
    expect(listened).toBe(0);
    controller.abort();
    await host.stop();
  });
});
