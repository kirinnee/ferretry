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
import { FRAME_KINDS, type SessionId } from '../../../worker/src/lib/index.ts';
import { BrowserEnd, impostorDaemon, type KernelFixture, kernelFixture } from '../../support/kernel-session.ts';

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

/**
 * WHAT SITS BETWEEN THE BROWSER AND THE DAEMON: Cloudflare's edge, and Ferretry's own service that provisioned the
 * hostname. Both see every byte and may do anything to it, so a test hands it a hostile hand: each direction may return
 * the frames that go on in place of the one it saw (none, to drop it; two, to insert or replay).
 */
interface Middlebox {
  readonly up?: (bytes: Uint8Array) => readonly Uint8Array[];
  readonly down?: (bytes: Uint8Array) => readonly Uint8Array[];
}

/** Opens one session as `cloudflared` would deliver it; `opened` collects `<carrier key> <peer address>` per session. */
async function throughTheTunnel(fx: KernelFixture, opened: string[], middlebox: Middlebox = {}) {
  /** Every frame each way, exactly as the middlebox saw it (before it did anything to it). */
  const seen = { up: [] as Uint8Array[], down: [] as Uint8Array[] };
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
    stopping: () => false,
  }).open({ carrier: 'tunnel' as CarrierKey, surface: { socket: declared.key, peer: tunnelPeer } });
  cleanups.push(() => listener.close());
  // What `cloudflared` forwards: a loopback upgrade, carrying the address Cloudflare's edge saw.
  const socketClient = new WebSocket(`ws://127.0.0.1:${String(listener.port)}/v1/rendezvous/${fx.daemonId}/client`, {
    headers: { 'cf-connecting-ip': '203.0.113.9' },
  } as never);
  socketClient.binaryType = 'arraybuffer';
  cleanups.push(() => socketClient.close());
  const browser = new NetworkBrowser(bytes => {
    seen.up.push(Uint8Array.from(bytes));
    for (const forwarded of middlebox.up?.(bytes) ?? [bytes]) socketClient.send(forwarded as BufferSource);
  });
  socketClient.onmessage = event => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(event.data);
    seen.down.push(Uint8Array.from(bytes));
    for (const forwarded of middlebox.down?.(bytes) ?? [bytes]) browser.receive(forwarded);
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
  return { browser, sessionId: ready.sessionId as SessionId, seen, drop: () => socketClient.close() };
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

const isData = (bytes: Uint8Array): boolean => bytes[2] === FRAME_KINDS.data;
const isHandshake = (bytes: Uint8Array): boolean => bytes[2] === FRAME_KINDS.handshake;
const contains = (haystack: Uint8Array, needle: string): boolean =>
  Buffer.from(haystack).toString('latin1').includes(needle);

/** A paired, authenticated tunnel session whose middlebox turns hostile only once `hostile.on` is set. */
async function authenticatedThrough(hostile: { on: boolean; up?: Middlebox['up']; down?: Middlebox['down'] }) {
  const fx = await kernelFixture();
  const device = await fx.paired();
  const opened: string[] = [];
  const through = await throughTheTunnel(fx, opened, {
    up: bytes => (hostile.on ? (hostile.up?.(bytes) ?? [bytes]) : [bytes]),
    down: bytes => (hostile.on ? (hostile.down?.(bytes) ?? [bytes]) : [bytes]),
  });
  expect(await through.browser.handshake(through.sessionId, fx.daemonId)).toBe(true);
  await through.browser.auth(device);
  await through.browser.settled();
  return { fx, ...through };
}

it('R668 a middlebox that ALTERS a sealed request cannot get it carried: the daemon refuses the record and ends the session', async () => {
  // Arrange
  const hostile = {
    on: false,
    up: (bytes: Uint8Array): readonly Uint8Array[] => {
      if (!isData(bytes)) return [bytes];
      const altered = Uint8Array.from(bytes);
      altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 0x01;
      return [altered];
    },
  };
  const { fx, browser } = await authenticatedThrough(hostile);

  // Act
  hostile.on = true;
  await browser.send({ t: 'req', id: 1, method: 'GET', path: '/v1/health' });
  await browser.settled();

  // Assert — a flipped bit fails the AEAD: nothing reached the dispatcher and the session is over.
  expect(fx.requests).toHaveLength(0);
  expect(browser.end).toBeDefined();
  fx.layer.close();
});

it('R668 a middlebox that REPLAYS a sealed request gets it carried once, and the repeat is refused', async () => {
  // Arrange
  const hostile = {
    on: false,
    up: (bytes: Uint8Array): readonly Uint8Array[] => (isData(bytes) ? [bytes, bytes] : [bytes]),
  };
  const { fx, browser } = await authenticatedThrough(hostile);

  // Act
  hostile.on = true;
  await browser.send({ t: 'req', id: 1, method: 'GET', path: '/v1/health' });
  await browser.settled();

  // Assert
  expect(fx.requests).toHaveLength(1);
  expect(browser.end).toBeDefined();
  fx.layer.close();
});

it('R668 a middlebox that DROPS a sealed request carries nothing, and the sequence gap it leaves refuses the next', async () => {
  // Arrange
  let dropped = false;
  const hostile = {
    on: false,
    up: (bytes: Uint8Array): readonly Uint8Array[] => {
      if (!isData(bytes) || dropped) return [bytes];
      dropped = true;
      return [];
    },
  };
  const { fx, browser } = await authenticatedThrough(hostile);

  // Act
  hostile.on = true;
  await browser.send({ t: 'req', id: 1, method: 'GET', path: '/v1/health' });
  await browser.send({ t: 'req', id: 2, method: 'GET', path: '/v1/health' });
  await browser.settled();

  // Assert — neither request is carried: the first never arrived, and the second is out of sequence.
  expect(fx.requests).toHaveLength(0);
  expect(browser.end).toBeDefined();
  fx.layer.close();
});

it('R668 a middlebox that INSERTS a frame of its own cannot get it carried', async () => {
  // Arrange — it forges a data frame in the session's own header, with a body it made up.
  const hostile = {
    on: false,
    up: (bytes: Uint8Array): readonly Uint8Array[] => {
      if (!isData(bytes)) return [bytes];
      const forged = Uint8Array.from(bytes);
      forged.fill(0x41, 28);
      return [forged, bytes];
    },
  };
  const { fx, browser } = await authenticatedThrough(hostile);

  // Act
  hostile.on = true;
  await browser.send({ t: 'req', id: 1, method: 'GET', path: '/v1/health' });
  await browser.settled();

  // Assert
  expect(fx.requests).toHaveLength(0);
  expect(browser.end).toBeDefined();
  fx.layer.close();
});

it('R668 a middlebox that READS every frame learns no request path, response or credential', async () => {
  // Arrange
  const hostile = { on: false };
  const { fx, browser, seen } = await authenticatedThrough(hostile);
  const path = '/v1/health';

  // Act
  await browser.send({ t: 'req', id: 1, method: 'GET', path });
  await browser.settled();

  // Assert — the request was carried, and every byte the middlebox saw either way holds none of it.
  expect(fx.requests).toHaveLength(1);
  const every = [...seen.up, ...seen.down];
  expect(every.length).toBeGreaterThan(3);
  for (const bytes of every) {
    expect(contains(bytes, '/v1/health')).toBe(false);
    expect(contains(bytes, '"method"')).toBe(false);
    expect(contains(bytes, 'appSession')).toBe(false);
  }
  fx.layer.close();
});

it('R668 a middlebox that ANSWERS AS the daemon cannot impersonate it: the browser pinned to the real identity refuses', async () => {
  // Arrange — the middlebox swallows the browser's hello and answers with a hello signed by its own key.
  const fx = await kernelFixture();
  const device = await fx.paired();
  const impostor = await impostorDaemon();
  let browserEnd: BrowserEnd | undefined;
  const through = await throughTheTunnel(fx, [], {
    up: bytes => {
      if (!isHandshake(bytes)) return [bytes];
      void impostor.answer(bytes).then(reply => {
        if (reply !== undefined) browserEnd?.receive(reply);
      });
      return [];
    },
    down: bytes => (isHandshake(bytes) ? [] : [bytes]),
  });
  browserEnd = through.browser;

  // Act
  const keyed = await through.browser.handshake(through.sessionId, fx.daemonId);

  // Assert — no keys, so the device proof is never signed and nothing the browser holds reaches the impostor.
  expect(keyed).toBe(false);
  expect(through.browser.keyed).toBe(false);
  await expect(through.browser.auth(device)).rejects.toThrow('not keyed');
  expect(through.seen.up.some(isData)).toBe(false);
  expect(fx.requests).toHaveLength(0);
  fx.layer.close();
});

it('R668 a middlebox that DROPS the connection ends the session and nothing more: it carries no request on its own', async () => {
  // Arrange
  const { fx, browser, drop } = await authenticatedThrough({ on: false });

  // Act
  drop();
  await browser.settled();

  // Assert
  expect(browser.end).toBeDefined();
  expect(fx.requests).toHaveLength(0);
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
