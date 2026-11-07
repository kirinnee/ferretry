/**
 * The tunnel listener's boundary over the REAL kernel session layer: what an arrival through `cloudflared` is
 * opened as. The listener is production code; the socket route behind it is a fixture of the direct carrier's
 * (Connections A's) — it opens the kernel session on the carrier the ARRIVAL names, as that route does — so a
 * listener that let a tunnel socket reach a `direct` session would show here as a pairing that went through.
 */

import { expect, it } from 'bun:test';
import {
  type ApiRequest,
  type CarrierKey,
  headersFrom,
  isSessionEnd,
  queryFrom,
  type SocketDownstream,
  type SocketHandler,
} from '@ferretry/kernel/contract';
import { owner, testArrival } from '@ferretry/kernel/testing';
import { tunnelListenerSurface } from '../../../daemon/lib/tunnel/listener.ts';
import {
  encodeControlMessage,
  encodeFrame,
  FRAME_KINDS,
  RELAY_LIMITS,
  RELAY_PROTOCOL_ID,
  SESSION_ID_BYTES,
  type SessionId,
  sessionIdFromBytes,
} from '../../../worker/src/lib/index.ts';
import { BrowserEnd, type KernelFixture, kernelCrypto, kernelFixture } from '../../support/kernel-session.ts';

/** The direct carrier's session route, as a fixture: one socket, one kernel session, on the arrival's carrier. */
function directSessionRoute(fx: KernelFixture, opened: string[]) {
  return (request: ApiRequest) =>
    async (downstream: SocketDownstream): Promise<SocketHandler> => {
      const sessionId = sessionIdFromBytes(kernelCrypto.randomBytes(SESSION_ID_BYTES)) as SessionId;
      const carrier = request.arrival.kind === 'carried' ? request.arrival.carrier : ('local' as CarrierKey);
      opened.push(`${String(carrier)} ${String(request.clientAddress)}`);
      const link = fx.layer.open(carrier, { address: String(request.clientAddress) });
      const pump = () => {
        for (let next = link.outbound.next(); next !== undefined; next = link.outbound.next()) {
          if (isSessionEnd(next)) {
            downstream.close(next.code, next.reason);
            return;
          }
          downstream.send(next.bytes);
        }
      };
      return {
        open: async () => {
          downstream.send(
            encodeFrame({
              kind: FRAME_KINDS.control,
              sessionId,
              sequence: 0,
              payload: encodeControlMessage({ t: 'ready', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS }),
            }),
          );
          link.outbound.onReady(pump);
          pump();
        },
        fromClient: frame => {
          if (typeof frame !== 'string')
            link.inbound(
              frame instanceof ArrayBuffer
                ? new Uint8Array(frame)
                : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
            );
        },
        close: () => link.closed('the socket closed'),
      };
    };
}

async function throughTheTunnel(fx: KernelFixture, opened: string[]) {
  const path = `/v1/rendezvous/${fx.daemonId}/client`;
  const route = directSessionRoute(fx, opened);
  const surface = tunnelListenerSurface({
    sockets: {
      claims: request => request.path === path,
      upgrade: async request => ({ outcome: 'accepted', attach: route(request) }),
    },
    corsOrigins: [],
  });
  // What `cloudflared` forwards: a loopback upgrade, carrying the address Cloudflare's edge saw.
  const decision = await surface.sockets.upgrade({
    method: 'GET',
    path,
    query: queryFrom([]),
    headers: headersFrom({ 'cf-connecting-ip': '203.0.113.9' }),
    arrival: testArrival(owner()),
    text: async () => '',
  });
  if (decision.outcome !== 'accepted') throw new Error('the listener refused its own session route');
  let handler: SocketHandler | undefined;
  const browser = new BrowserEnd(bytes => handler?.fromClient(bytes));
  handler = await decision.attach(browser.downstream());
  await handler.open();
  await browser.settled();
  const ready = browser.controls[0];
  if (ready?.message.t !== 'ready') throw new Error('no ready');
  return { browser, sessionId: ready.sessionId };
}

it('G118 every tunnel session is the §6 handshake against the pinned identity, opened as a remote tunnel arrival', async () => {
  // Arrange
  const fx = await kernelFixture();
  const opened: string[] = [];
  const device = await fx.paired();

  // Act — the same listener, one browser pinning this daemon and one pinning another.
  const pinned = await throughTheTunnel(fx, opened);
  const impostor = await throughTheTunnel(fx, opened);
  expect(await pinned.browser.handshake(pinned.sessionId, fx.daemonId)).toBe(true);
  expect(await impostor.browser.handshake(impostor.sessionId, 'fy_daemon_not_this_one')).toBe(false);
  await pinned.browser.auth(device);
  await pinned.browser.send({ t: 'req', id: 1, method: 'GET', path: '/v1/health' });
  await pinned.browser.settled();

  // Assert — opened on the tunnel carrier, keyed by the edge's address; the request carried, never local.
  expect(opened).toEqual(['tunnel 203.0.113.9', 'tunnel 203.0.113.9']);
  expect(impostor.browser.keyed).toBe(false);
  expect(fx.requests).toHaveLength(1);
  expect(fx.requests[0]?.arrival).toMatchObject({ kind: 'carried', carrier: 'tunnel' });
  expect(fx.requests[0]?.principal).toMatchObject({ kind: 'device', holder: device.deviceId });
  fx.layer.close();
});

for (const row of ['G118', 'R662'])
  it(`${row} a pairing through the tunnel listener gets the uniform pair-refused, spends no budget and records no grant`, async () => {
    // Arrange
    const fx = await kernelFixture();
    const { browser, sessionId } = await throughTheTunnel(fx, []);
    expect(await browser.handshake(sessionId, fx.daemonId)).toBe(true);

    // Act — a well-formed first contact, its proof bound to this session's own transcript.
    await browser.pair();
    await browser.settled();

    // Assert — the pair mode (which owns the guess budget and the grant) was never asked.
    expect(browser.last('pair-refused')).toMatchObject({ reason: 'pairing_refused' });
    expect(browser.last('paired')).toBeUndefined();
    expect(browser.end?.code).toBe(4440);
    expect(fx.pair.attempts).toHaveLength(0);
    fx.layer.close();
  });
