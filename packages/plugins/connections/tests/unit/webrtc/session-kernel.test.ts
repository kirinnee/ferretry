/**
 * Connections' WebRTC session adapter over the REAL kernel session layer: the channel is the carrier, so it
 * mints the session id and announces `ready` — the browser starts its §6 handshake only on `ready`, and the
 * kernel session waits for that handshake, so an adapter that only pumped kernel traffic would deadlock both.
 */

import { expect, it } from 'bun:test';
import { sealedWebRtcSessions } from '../../../daemon/lib/webrtc/session.ts';
import { RELAY_LIMITS, RELAY_PROTOCOL_ID, RENDEZVOUS_SESSION_ID } from '../../../worker/src/lib/index.ts';
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
