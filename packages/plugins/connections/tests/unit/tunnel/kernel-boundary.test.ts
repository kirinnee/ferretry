/**
 * The tunnel listener's boundary over the REAL kernel session layer: what an arrival through `cloudflared` is opened as.
 *
 * Everything on the path is production code: the kernel's own carrier listener (`carrierListenerPort`), dialled over a
 * real loopback WebSocket as `cloudflared` would, serving Connections' REAL `directCarrierSocketRoute` through the
 * kernel's real `Dispatcher`, which opens the kernel's real session layer. The only stand-ins are the ones the kernel
 * fixture has always had (an in-memory device table, a pair mode that RECORDS every attempt) and an admission that
 * admits, because the sealed session proves the device itself. The one wrapper is `openSession`, which records the
 * carrier key it was handed and passes the call straight to `openKernelSession`. A route that opened a tunnel socket as
 * a `direct` session therefore shows here as a pairing that went through.
 */

import { afterEach, expect, it } from 'bun:test';
import type { CallStanding, CarrierKey } from '@ferretry/kernel/contract';
import { carrierListenerPort } from '../../../../../core/kernel/host/carrier-listener.ts';
import { Dispatcher } from '../../../../../core/kernel/host/dispatch.ts';
import { openKernelSession } from '../../../daemon/index.ts';
import { directCarrierSocketRoute } from '../../../daemon/lib/runtime/mounts/direct-carrier.ts';
import { tunnelPeer } from '../../../daemon/lib/tunnel/listener.ts';
import manifest from '../../../manifest.ts';
import type { SessionId } from '../../../worker/src/lib/index.ts';
import { BrowserEnd, type KernelFixture, kernelFixture } from '../../support/kernel-session.ts';

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

/** Opens one session as `cloudflared` would deliver it; `opened` collects `<carrier key> <peer address>` per session. */
async function throughTheTunnel(fx: KernelFixture, opened: string[]) {
  const route = directCarrierSocketRoute({
    identity: { daemonId: fx.daemonId },
    clock: { now: () => Date.now() },
    scheduler: { after: () => ({ cancel: () => undefined }) },
    randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
    sessions: () => fx.layer,
    openSession: (layer, key, peer, proved) => {
      opened.push(`${String(key)} ${String(peer.address)}`);
      return openKernelSession(layer, key, peer, proved);
    },
  });
  cleanups.push(() => route.stop());
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
          accept: route.accept,
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
  return { browser, sessionId: ready.sessionId as SessionId };
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
    const opened: string[] = [];
    const { browser, sessionId } = await throughTheTunnel(fx, opened);
    expect(await browser.handshake(sessionId, fx.daemonId)).toBe(true);

    // Act — a well-formed first contact, its proof bound to this session's own transcript.
    await browser.pair();
    await browser.settled();

    // Assert — the session is a tunnel one, so the layer refuses before the pair mode (which owns the guess budget and
    // records the grant) is ever asked: no attempt, therefore no budget spent and no grant.
    expect(opened).toEqual(['tunnel 203.0.113.9']);
    expect(browser.last('pair-refused')).toMatchObject({ reason: 'pairing_refused' });
    expect(browser.last('paired')).toBeUndefined();
    expect(browser.end?.code).toBe(4440);
    expect(fx.pair.attempts).toHaveLength(0);
    fx.layer.close();
  });
