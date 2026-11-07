import { expect, it } from 'bun:test';
import { headersFrom, queryFrom, type ApiRequest, type RouteHandler } from '@ferretry/kernel/contract';
import { device, owner, testArrival, testPrincipal } from '@ferretry/kernel/testing';
import { instantFromEpochMs } from '@ferretry/std';
import { createConnectionB } from '../../../daemon/connection-b.ts';

function harness() {
  const offers: string[] = [];
  const writes: boolean[] = [];
  const built = createConnectionB({
    tunnel: {
      entry: { kind: 'tunnel', source: 'discovery', enabled: false },
      explicit: false,
      discoveryOrigin: undefined,
      cloudflared: { locate: () => ({ kind: 'absent', reason: 'not found' }) },
      service: { read: async () => ({ kind: 'unavailable', reason: 'off' }) },
      holding: { read: async () => undefined, record: async () => {}, forget: async () => {} },
      identity: async () => ({ ok: false, reason: 'not used' }),
      provisioner: () => {
        throw new Error('not used');
      },
      openListener: async () => {
        throw new Error('not used');
      },
      processes: {
        spawn: () => {
          throw new Error('not used');
        },
      },
      scheduler: { after: () => ({ cancel: () => {} }) },
      random: () => 0,
      publish: () => {},
      notices: { step: () => {}, state: () => {} },
    },
    tunnelStore: {
      write: async entry => {
        writes.push(entry.enabled);
      },
    },
    webrtc: {
      availability: { kind: 'ready' },
      iceServers: [],
      peerId: () => 'peer-1',
      scheduler: { after: () => ({ cancel: () => {} }) },
      engine: {
        answer: async sdp => {
          offers.push(sdp);
          return { sdp: 'answer', peer: { onChannel: () => {}, onClosed: () => {}, close: () => {} } };
        },
        release: () => {},
      },
    },
    sessionLayer: {
      open: () => {
        throw new Error('no channel has opened');
      },
    },
    device: () => ({ deviceId: 'verified-holder', appSession: 'verified-page' }),
    onStop: () => {},
  });
  const call = (body: string, paired = false): Parameters<RouteHandler>[0] => {
    const caller = paired ? device('verified-holder') : owner();
    const request: ApiRequest = {
      method: 'POST',
      path: '/v1/webrtc/offer',
      headers: headersFrom({}),
      query: queryFrom([]),
      arrival: testArrival(caller),
      principal: testPrincipal(caller, instantFromEpochMs(1000)),
      text: async () => body,
    };
    return { request, params: new Map() };
  };
  return { built, call, offers, writes };
}
it('R671 only a kernel-verified device principal can allocate a WebRTC peer', async () => {
  const h = harness();
  await expect(h.built.routes['POST /v1/webrtc/offer'](h.call('{"sdp":"offer"}'))).rejects.toMatchObject({
    status: 403,
    code: 'webrtc_device_only',
  });
  expect(h.offers).toEqual([]);
  const response = await h.built.routes['POST /v1/webrtc/offer'](h.call('{"sdp":"offer"}', true));
  expect(JSON.parse(response.body)).toEqual({ sdp: 'answer' });
  expect(h.offers).toEqual(['offer']);
});
it('R672 malformed or oversized SDP refuses before the native engine receives it', async () => {
  const h = harness();
  await expect(h.built.routes['POST /v1/webrtc/offer'](h.call('{broken', true))).rejects.toMatchObject({
    status: 400,
    code: 'invalid_json',
  });
  await expect(
    h.built.routes['POST /v1/webrtc/offer'](h.call(JSON.stringify({ sdp: 'x'.repeat(32769) }), true)),
  ).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  expect(h.offers).toEqual([]);
});
it('R657 tunnel handlers parse a switch, persist it and answer its live view', async () => {
  const h = harness();
  await h.built.routes['PUT /v1/tunnel'](h.call('{"enabled":true}', true));
  expect(h.writes).toEqual([true]);
  const response = await h.built.routes['GET /v1/tunnel']();
  expect(JSON.parse(response.body)).toMatchObject({ enabled: true, explicit: true, state: 'provisioning' });
});
