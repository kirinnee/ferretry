/**
 * WebRTC signalling over the REAL kernel session layer: the offer is Connections' own route, reached only as a
 * sealed request inside a device-authenticated session that already reaches the daemon (§16). So the carrier
 * that delivers it — a rendezvous here — sees ciphertext, and only a paired device can make the engine open a
 * UDP port.
 */

import { expect, it } from 'bun:test';
import type { ApiRequest, CarrierLink, RouteHandler } from '@ferretry/kernel/contract';
import { createConnectionB } from '../../../daemon/connection-b.ts';
import { decodeControlMessage, encodeControlMessage } from '../../../worker/src/lib/index.ts';
import { session } from '@ferretry/kernel/host';
import { BrowserEnd, type KernelFixture, kernelCrypto, kernelFixture } from '../../support/kernel-session.ts';

function freshSessionId(): session.SessionId {
  const id = session.sessionIdFromBytes(kernelCrypto.randomBytes(16));
  if (id === null) throw new Error('fixture session id');
  return id;
}

const SDP = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 SDP-MARKER-7f3k\r\n';

function signalling(fx: KernelFixture) {
  const offers: string[] = [];
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
    tunnelStore: { write: async () => {} },
    webrtc: {
      availability: { kind: 'ready' },
      iceServers: [],
      peerId: () => 'peer-1',
      scheduler: { after: () => ({ cancel: () => {} }) },
      engine: {
        // Answering is what opens a UDP port.
        answer: async sdp => {
          offers.push(sdp);
          return { sdp: 'v=0 answer', peer: { onChannel: () => {}, onClosed: () => {}, close: () => {} } };
        },
        release: () => {},
      },
    },
    sessionLayer: () => fx.layer,
    // TODO(kernel contract) as in `verifiedWebRtcDevice`: the kernel principal does not carry `appSession` yet,
    // so the page id is the kernel's own session id for that principal — still the verified call, never the body.
    device: call => {
      const principal = call.request.principal;
      return principal?.kind === 'device'
        ? { deviceId: principal.holder, appSession: String(principal.session) }
        : undefined;
    },
    onStop: () => {},
  });
  const offer: RouteHandler = built.routes['POST /v1/webrtc/offer'];
  fx.route = async (request: ApiRequest) => await offer({ request, params: new Map() });
  return { offers };
}

/** One browser on a relayed session, recording every byte that crosses the carrier in either direction. */
function relayed(fx: KernelFixture) {
  const link: CarrierLink = fx.layer.open('relay' as never, { address: 'rendezvous-peer' });
  const sent: Uint8Array[] = [];
  const browser = new BrowserEnd(bytes => {
    sent.push(Uint8Array.from(bytes));
    link.inbound(bytes);
  }).pullFrom(link);
  return { link, browser, sent };
}

const crossed = (frames: readonly Uint8Array[]): string =>
  frames.map(frame => new TextDecoder('utf-8', { fatal: false }).decode(frame)).join('\n');

const offerRecord = { t: 'req', id: 1, method: 'POST', path: '/v1/webrtc/offer', body: JSON.stringify({ sdp: SDP }) };

it('R674 the offer crosses the relay sealed, and only a paired device can make the daemon answer it', async () => {
  // Arrange
  const fx = await kernelFixture();
  const { offers } = signalling(fx);
  const device = await fx.paired();

  // Act — a paired device's session posts the offer through a rendezvous.
  const paired = relayed(fx);
  expect(await paired.browser.handshake(freshSessionId(), fx.daemonId)).toBe(true);
  await paired.browser.auth(device);
  await paired.browser.settled();
  await paired.browser.send(offerRecord);
  await paired.browser.settled();
  await paired.browser.settled();

  // Assert — answered inside the session, and neither direction carried SDP the relay could read.
  expect(offers).toEqual([SDP]);
  expect(paired.browser.last('res')).toMatchObject({ id: 1, status: 200 });
  const wire = crossed([...paired.sent, ...paired.browser.wire]);
  expect(wire).not.toContain('SDP-MARKER-7f3k');
  expect(wire).not.toContain('v=0');
  expect(wire).not.toContain('webrtc/offer');

  // Act — a session whose device is not paired, and one that never proved any device.
  const stranger = relayed(fx);
  expect(await stranger.browser.handshake(freshSessionId(), fx.daemonId)).toBe(true);
  await stranger.browser.auth({ ...(await fx.paired('B')), deviceId: `fy_device_id_${'Z'.repeat(22)}` });
  await stranger.browser.settled();
  const unproved = relayed(fx);
  expect(await unproved.browser.handshake(freshSessionId(), fx.daemonId)).toBe(true);
  await unproved.browser.send(offerRecord);
  await unproved.browser.settled();

  // Assert — neither reached the engine: no UDP port was opened for them.
  expect(stranger.browser.end?.code).toBe(4403);
  expect(unproved.browser.end).toBeDefined();
  expect(offers).toEqual([SDP]);

  // The rendezvous's own vocabulary has no signalling message to change: an SDP control is not one it parses.
  expect(decodeControlMessage(encodeControlMessage({ t: 'offer', sdp: SDP } as never))).toBeNull();
  fx.layer.close();
});
