/**
 * Connections' WebRTC session adapter over the REAL kernel session layer: the channel is the carrier, so it
 * mints the session id and announces `ready` — the browser starts its §6 handshake only on `ready`, and the
 * kernel session waits for that handshake, so an adapter that only pumped kernel traffic would deadlock both.
 */

import { expect, it } from 'bun:test';
import { WEBRTC_SESSION_CHANNEL_LABEL } from '../../../contract/index.ts';
import { WebRtcCarrier, type WebRtcChannelPort, type WebRtcPeerPort } from '../../../daemon/lib/webrtc/index.ts';
import { sealedWebRtcSessions } from '../../../daemon/lib/webrtc/session.ts';
import {
  DEFAULT_HOSTED_RELAY_LIMITS,
  RELAY_LIMITS,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
} from '../../../worker/src/lib/index.ts';
import { BrowserEnd, type KernelFixture, kernelCrypto, kernelFixture } from '../../support/kernel-session.ts';

const ADDRESS = 'webrtc-peer:minted-by-daemon';

function channel(fx: KernelFixture) {
  let session: ReturnType<ReturnType<typeof sealedWebRtcSessions>>;
  const browser = new BrowserEnd(bytes => session?.fromClient(bytes));
  let released = 0;
  session = sealedWebRtcSessions(fx.layer, { after: (delay, fn) => ({ cancel: fx.clock.after(delay, fn) }) }, length =>
    kernelCrypto.randomBytes(length),
  )({ kind: 'carried', carrier: 'webrtc', address: ADDRESS }, browser.downstream(), () => {
    released += 1;
  });
  if (session === undefined) throw new Error('no session');
  return { session, browser, released: () => released };
}

it('a WebRTC channel announces ready with its own nonzero session id before any kernel traffic, so the handshake starts', async () => {
  // Arrange
  const fx = await kernelFixture();
  const { session, browser } = channel(fx);

  // Act
  await session.open();
  await browser.settled();

  // Assert — the first frame is the carrier's `ready`, addressed to the id the carrier minted.
  expect(browser.wire).toHaveLength(1);
  expect(browser.controls).toEqual([
    { sessionId: session.sessionId, message: { t: 'ready', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS } },
  ]);
  expect(session.sessionId.text).not.toBe(RENDEZVOUS_SESSION_ID.text);
  expect(session.sessionId.bytes.some(byte => byte !== 0)).toBe(true);
  // Two channels never share an id.
  const other = channel(fx);
  expect(other.session.sessionId.text).not.toBe(session.sessionId.text);

  // Act — the browser answers `ready` with its handshake and proves a paired device, as session-client does.
  const device = await fx.paired();
  expect(await browser.handshake(session.sessionId, fx.daemonId)).toBe(true);
  await browser.auth(device);
  await browser.settled();
  fx.clock.advance(30_000);
  await browser.settled();

  // Assert — the session is live past the credential deadline, not closed for want of a credential.
  expect(browser.last('authenticated')).toBeDefined();
  expect(browser.end).toBeUndefined();
  fx.layer.close();
});

it('R682 over WebRTC the §6 pin authenticates the daemon, not DTLS: a wrong pin never keys and never reaches a route', async () => {
  // Arrange
  const fx = await kernelFixture();
  const pinned = channel(fx);
  const impostor = channel(fx);
  const device = await fx.paired();

  // Act — the same channel kind, the same arrival, two different pins.
  await pinned.session.open();
  await impostor.session.open();
  const keyed = await pinned.browser.handshake(pinned.session.sessionId, fx.daemonId);
  const wrongPin = await impostor.browser.handshake(impostor.session.sessionId, 'fy_daemon_not_this_one');
  await pinned.browser.auth(device);
  await pinned.browser.send({ t: 'req', id: 1, method: 'GET', path: '/v1/health', headers: {} });
  await pinned.browser.settled();

  // Assert — only the pinned session keys, and what it carries is stamped by the kernel: a remote webrtc arrival
  // keyed by the daemon-minted peer, the principal the device proof earned, nothing DTLS said.
  expect(keyed).toBe(true);
  expect(wrongPin).toBe(false);
  expect(impostor.browser.keyed).toBe(false);
  expect(fx.requests).toHaveLength(1);
  expect(fx.requests[0]?.arrival).toMatchObject({ kind: 'carried', carrier: 'webrtc' });
  expect(fx.requests[0]?.principal).toMatchObject({ kind: 'device', holder: device.deviceId });
  fx.layer.close();
});

it('R675 pairing never crosses WebRTC: the channel carries the uniform pair-refused and the pair mode is never asked', async () => {
  // Arrange
  const fx = await kernelFixture();
  const { session, browser, released } = channel(fx);
  await session.open();
  expect(await browser.handshake(session.sessionId, fx.daemonId)).toBe(true);

  // Act — a well-formed pairing, its proof bound to this session's own transcript.
  await browser.pair();
  await browser.settled();

  // Assert
  expect(browser.last('pair-refused')).toMatchObject({ reason: 'pairing_refused' });
  expect(browser.last('paired')).toBeUndefined();
  expect(browser.end?.code).toBe(4440);
  expect(fx.pair.attempts).toHaveLength(0);
  expect(released()).toBe(1);
  fx.layer.close();
});

/** A data channel between the carrier and one {@link BrowserEnd}. */
class Channel implements WebRtcChannelPort {
  readonly label = WEBRTC_SESSION_CHANNEL_LABEL;
  closed = false;
  #message: ((frame: string | Uint8Array) => void) | undefined;
  readonly browser = new BrowserEnd(bytes => this.#message?.(bytes));
  send(frame: Uint8Array): boolean {
    if (this.closed) return false;
    this.browser.receive(frame);
    return true;
  }
  sendText(): boolean {
    return !this.closed;
  }
  bufferedBytes(): number {
    return 0;
  }
  close(): void {
    this.closed = true;
  }
  onMessage(listener: (frame: string | Uint8Array) => void): void {
    this.#message = listener;
  }
  onClosed(): void {}
}

class Peer implements WebRtcPeerPort {
  #channel: ((channel: WebRtcChannelPort) => void) | undefined;
  onChannel(listener: (channel: WebRtcChannelPort) => void): void {
    this.#channel = listener;
  }
  onClosed(): void {}
  close(): void {}
  open(): Channel {
    const channel = new Channel();
    this.#channel?.(channel);
    return channel;
  }
}

it('R670 WebRTC sessions are never charged against hosted ceilings: more than the hosted per-daemon cap are all served, none 4432/4433', async () => {
  // Arrange — the carrier as Connections composes it, over the real kernel layer.
  const fx = await kernelFixture();
  const peers: Peer[] = [];
  let minted = 0;
  const carrier = new WebRtcCarrier({
    availability: { kind: 'ready' },
    engine: {
      answer: async () => {
        const peer = new Peer();
        peers.push(peer);
        return { sdp: 'answer', peer };
      },
      release: () => undefined,
    },
    iceServers: [],
    scheduler: { after: (delay, fn) => ({ cancel: fx.clock.after(delay, fn) }) },
    peerId: () => {
      minted += 1;
      return `peer-${String(minted)}`;
    },
    sessions: sealedWebRtcSessions(
      fx.layer,
      { after: (delay, fn) => ({ cancel: fx.clock.after(delay, fn) }) },
      length => kernelCrypto.randomBytes(length),
    ),
  });
  const device = await fx.paired();
  const wanted = DEFAULT_HOSTED_RELAY_LIMITS.maxConcurrentConnectionsPerDaemon + 4;

  // Act — three copies of the app, each with a full peer of channels, every channel a proved session.
  for (let copy = 0; copy < 3; copy += 1)
    expect(await carrier.offer('offer', { deviceId: device.deviceId, appSession: `copy-${String(copy)}` })).toEqual({
      kind: 'answered',
      sdp: 'answer',
    });
  const channels: Channel[] = [];
  // One at a time: the kernel's own pre-credential bound (R232) is not what is being measured here.
  for (const peer of peers)
    for (let index = 0; index < 8 && channels.length < wanted; index += 1) {
      const channel = peer.open();
      channels.push(channel);
      await channel.browser.settled();
      const ready = channel.browser.controls[0];
      if (ready === undefined) throw new Error('no ready');
      expect(await channel.browser.handshake(ready.sessionId, fx.daemonId)).toBe(true);
      await channel.browser.auth(device);
    }
  for (const channel of channels) await channel.browser.settled();

  // Assert — every one is live; nothing refused with a hosted code, and no channel closed.
  expect(channels).toHaveLength(wanted);
  for (const channel of channels) {
    expect(channel.browser.last('authenticated')).toBeDefined();
    expect(channel.browser.controls.map(control => control.message.t)).toEqual(['ready']);
    expect(channel.closed).toBe(false);
  }
  carrier.close();
  fx.layer.close();
});
