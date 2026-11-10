/**
 * The rendezvous link against the Kernel's REAL session layer, for the three rows that are about what the relay
 * hands the Kernel rather than about the link's own bookkeeping (Appendix D, connections batch 3):
 *
 * - R207 a relayed request becomes the same `ApiRequest` a bound address serves;
 * - R215 the daemon signs its claim with the identity pairing minted;
 * - R222 a relayed caller's rate-limit key is its rendezvous session.
 *
 * The fixture is `tests/support/kernel-session.ts`: real WebCrypto, the Kernel's own handshake, proofs and records,
 * and the browser's half of them. Only the session modes, the dispatcher and the clock are stand-ins.
 */

import { describe, expect, test } from 'bun:test';
import { implementDaemon } from '@ferretry/kernel/manifest';
import type { ApiRequest, CarrierKey, KernelPorts } from '@ferretry/kernel/contract';
import {
  claimTranscript,
  decodeFrame,
  encodeFrame,
  FRAME_KINDS,
  fromBase64Url,
  NONCE_BYTES,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  sessionIdFromBytes,
  type SessionId,
  toBase64Url,
} from '@ferretry/kernel/wire';
import { testHost } from '../../../../../core/kernel/testing/host.ts';
import { buildConnections, kernelConnectionBindings } from '../../../daemon/index.ts';
import { type ControlMessage, decodeControlMessage, encodeControlMessage } from '../../../daemon/lib/relay/control.ts';
import { RelayLink } from '../../../daemon/lib/relay/link.ts';
import type { RendezvousSigner } from '../../../daemon/lib/relay/session-ports.ts';
import manifest from '../../../manifest.ts';
import { BrowserEnd, type KernelFixture, kernelFixture } from '../../support/kernel-session.ts';

const id = (n: number): SessionId => sessionIdFromBytes(new Uint8Array(16).fill(n))!;
const control = (message: ControlMessage, sessionId: SessionId = RENDEZVOUS_SESSION_ID) =>
  encodeFrame({ kind: FRAME_KINDS.control, sessionId, sequence: 0, payload: encodeControlMessage(message) });

/** A relay link over the fixture's real layer, with a browser whose frames go through it as a rendezvous would. */
function relayed(fx: KernelFixture, signer: RendezvousSigner = unusedSigner) {
  const sent: Uint8Array[] = [];
  const browser = new BrowserEnd(bytes => void link.accept(bytes));
  const link: RelayLink = new RelayLink({
    layer: fx.layer,
    relayHost: 'relay.example',
    identity: signer,
    socket: {
      send: bytes => {
        sent.push(bytes);
        browser.receive(bytes);
      },
      sendText: () => undefined,
      close: () => undefined,
    },
    scheduler: { after: (ms, fn) => ({ cancel: fx.clock.after(ms, fn) }) },
  });
  return { link, browser, sent };
}
const unusedSigner = {
  daemonId: 'fy_daemon_' + 'a'.repeat(43),
  sign: async () => Promise.reject(new Error('this fixture never claims')),
};

/** One authenticated `GET` through a relayed session; resolves to the request the kernel's dispatcher saw. */
async function relayedRequest(
  fx: KernelFixture,
  sessionId: SessionId,
  headers: Record<string, string> = {},
): Promise<{ readonly request: ApiRequest; readonly relay: ReturnType<typeof relayed> }> {
  const relay = relayed(fx);
  await relay.link.accept(control({ t: 'open' }, sessionId));
  expect(await relay.browser.handshake(sessionId, fx.daemonId)).toBe(true);
  await relay.browser.auth(await fx.paired(`R${String(sessionId.bytes[0])}`));
  await relay.browser.send({ t: 'req', id: 1, method: 'GET', path: '/v1/carriers', headers });
  await relay.browser.settled();
  const request = fx.requests.at(-1);
  if (request === undefined) throw new Error('the kernel dispatched nothing');
  return { request, relay };
}

/** The same request over a bound address: a `direct` session whose peer address the carrier knows. */
async function directRequest(fx: KernelFixture, address: string): Promise<ApiRequest> {
  const link = fx.layer.open('direct' as CarrierKey, { address });
  const browser = new BrowserEnd(bytes => link.inbound(bytes)).pullFrom(link);
  const sessionId = id(0x77);
  expect(await browser.handshake(sessionId, fx.daemonId)).toBe(true);
  await browser.auth(await fx.paired('D'));
  await browser.send({ t: 'req', id: 1, method: 'GET', path: '/v1/carriers', headers: {} });
  await browser.settled();
  const request = fx.requests.at(-1);
  if (request === undefined) throw new Error('the kernel dispatched nothing');
  return request;
}

describe('a relayed session against the real kernel', () => {
  test('R207 a relayed request is the same ApiRequest the bound address serves, with only its arrival and address differing', async () => {
    const fx = await kernelFixture();
    try {
      const over = await relayedRequest(fx, id(1));
      const bound = await directRequest(fx, '192.0.2.7');
      // One shape: the same keys, the same route, the same device principal kind, and no header credential.
      expect(Object.keys(over.request).sort()).toEqual(Object.keys(bound).sort());
      expect([over.request.method, over.request.path]).toEqual([bound.method, bound.path]);
      expect(over.request.principal?.kind).toBe('device');
      expect(over.request.principal?.kind).toBe(bound.principal?.kind);
      expect(over.request.headers.has('authorization')).toBe(false);
      // What differs is how it ARRIVED: carried over the relay, never local.
      expect(over.request.arrival).toEqual({ kind: 'carried', carrier: 'relay' as CarrierKey });
      expect(bound.arrival).toEqual({ kind: 'carried', carrier: 'direct' as CarrierKey });
    } finally {
      fx.layer.close();
    }
  });

  test('R222 a relayed caller is rate-limited by its rendezvous session, which no header or record it sends can choose', async () => {
    const fx = await kernelFixture();
    try {
      const first = await relayedRequest(fx, id(1), {
        'x-forwarded-for': '198.51.100.1',
        'cf-connecting-ip': '198.51.100.2',
        'x-real-ip': '198.51.100.3',
      });
      // The key is the session the rendezvous minted, whatever address the caller claims in what it sends.
      expect(first.request.clientAddress).toBe(`relay-session:${id(1).text}`);
      const second = await relayedRequest(fx, id(2));
      expect(second.request.clientAddress).toBe(`relay-session:${id(2).text}`);
      expect(second.request.clientAddress).not.toBe(first.request.clientAddress);
      // A carrier that knows the peer's own address (a bound socket) is keyed by that address instead.
      expect((await directRequest(fx, '192.0.2.7')).clientAddress).toBe('192.0.2.7');
    } finally {
      fx.layer.close();
    }
  });
});

describe('the claim a relayed daemon signs', () => {
  test('R215 the claim is signed with the identity pairing minted: the key behind the claim is the QR fingerprint', async () => {
    // The production binding, over the test host's kernel: the identity pairing mints a fingerprint from.
    let kernel: KernelPorts | undefined;
    const probe = implementDaemon(manifest, {
      build: ctx => {
        kernel = ctx.kernel;
        return buildConnections(ctx);
      },
    });
    const host = await testHost({ plugins: [probe] });
    const fx = await kernelFixture();
    try {
      const bindings = kernelConnectionBindings(kernel!);
      expect(bindings.identity.daemonId).toBe(host.identity.daemonId);
      const { link, sent } = relayed(fx, bindings.identity);
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      await link.accept(
        control({
          t: 'challenge',
          protocol: RELAY_PROTOCOL_ID,
          host: 'relay.example',
          nonce: toBase64Url(nonce),
          deadlineSeconds: 10,
        }),
      );
      const claim = sent
        .map(bytes => decodeFrame(bytes))
        .flatMap(decoded => (decoded.ok && decoded.frame.kind === FRAME_KINDS.control ? [decoded.frame] : []))
        .map(frame => decodeControlMessage(frame.payload))
        .find(message => message?.t === 'claim');
      if (claim?.t !== 'claim') throw new Error('no claim was sent');
      const publicKey = fromBase64Url(claim.publicKey)!;
      // The key the claim carries hashes to the daemon id pairing publishes in the QR (the pinned fingerprint)...
      const derived = `fy_daemon_${toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(publicKey))))}`;
      expect(derived).toBe(host.identity.daemonId);
      // ...and the signature verifies under that key over the claim transcript of that same id.
      const key = await crypto.subtle.importKey('spki', new Uint8Array(publicKey), { name: 'Ed25519' }, false, [
        'verify',
      ]);
      const transcript = claimTranscript({ daemonId: derived, relayHost: 'relay.example', challenge: nonce });
      const verify = (message: Uint8Array) =>
        crypto.subtle.verify(
          { name: 'Ed25519' },
          key,
          new Uint8Array(fromBase64Url(claim.signature)!),
          new Uint8Array(message),
        );
      expect(await verify(transcript)).toBe(true);
      // A claim for any other daemon id is a different message: this signature does not carry over.
      const other = claimTranscript({
        daemonId: `fy_daemon_${'z'.repeat(43)}`,
        relayHost: 'relay.example',
        challenge: nonce,
      });
      expect(await verify(other)).toBe(false);
    } finally {
      fx.layer.close();
      await host.stop();
    }
  });
});
