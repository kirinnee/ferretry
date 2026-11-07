/**
 * The tunnel listener's boundary over the REAL kernel session layer: what an arrival through `cloudflared` is
 * opened as. The listener is the KERNEL'S production carrier listener, dialled over a real loopback WebSocket as
 * `cloudflared` would; the socket route behind it is a fixture of the direct carrier's (Connections A's) — it opens
 * the kernel session on the carrier the ARRIVAL names, as that route does — so a listener that let a tunnel socket
 * reach a `direct` session would show here as a pairing that went through.
 */

import { afterEach, expect, it } from 'bun:test';
import {
  type ApiRequest,
  type CallStanding,
  type CarrierKey,
  isSessionEnd,
  type SocketDownstream,
  type SocketHandler,
} from '@ferretry/kernel/contract';
import { carrierListenerPort } from '../../../../../core/kernel/host/carrier-listener.ts';
import { Dispatcher } from '../../../../../core/kernel/host/dispatch.ts';
import { tunnelPeer } from '../../../daemon/lib/tunnel/listener.ts';
import manifest from '../../../manifest.ts';
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

/** A browser end over a real socket: every round waits for the network as well as for the layer. */
class NetworkBrowser extends BrowserEnd {
  override async settled(): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
      await Bun.sleep(20);
      await super.settled();
    }
  }
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function throughTheTunnel(fx: KernelFixture, opened: string[]) {
  const route = directSessionRoute(fx, opened);
  // The kernel's dispatcher over the one declared socket, admitting what the sealed session itself will prove.
  const declared = manifest.actions.sockets[0] as NonNullable<typeof manifest.actions.sockets>[number];
  const dispatcher = new Dispatcher(
    {
      admission: () => ({
        admit: () => ({ outcome: 'admitted', standing: {} as unknown as CallStanding, actor: 'owner-tools' }),
        admitMember: () => {
          throw new Error('no member call');
        },
        readmit: () => true,
        inventory: (_request, entries) => entries,
      }),
      outputGuard: () => undefined,
      version: '5.0.0',
    },
    {
      routes: [],
      sockets: [
        {
          ...declared,
          owner: { plugin: 'connections' as never, title: 'Connections', serving: () => ({ kind: 'serving' }) },
          accept: async call => route(call.request),
        },
      ],
      memberRoutes: [],
    },
  );
  const listener = await carrierListenerPort({
    manifest: manifest as never,
    dispatcher: () => dispatcher,
    daemonId: fx.daemonId,
    onStop: () => {},
  }).open({ carrier: 'tunnel' as CarrierKey, surface: { socket: declared.key, peer: tunnelPeer } });
  cleanups.push(() => listener.close());
  // What `cloudflared` forwards: a loopback upgrade, carrying the address Cloudflare's edge saw.
  const socketClient = new WebSocket(`ws://127.0.0.1:${String(listener.port)}/v1/rendezvous/${fx.daemonId}/client`, {
    headers: { 'cf-connecting-ip': '203.0.113.9' },
  } as never);
  socketClient.binaryType = 'arraybuffer';
  cleanups.push(() => socketClient.close());
  const browser = new NetworkBrowser(bytes => socketClient.send(bytes as BufferSource));
  socketClient.onmessage = event => {
    if (event.data instanceof ArrayBuffer) browser.receive(new Uint8Array(event.data));
  };
  socketClient.onclose = event => {
    browser.end ??= { code: event.code, reason: event.reason };
  };
  await new Promise<void>((resolve, reject) => {
    socketClient.onopen = () => resolve();
    socketClient.onerror = () => reject(new Error('the listener refused its own session route'));
  });
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
