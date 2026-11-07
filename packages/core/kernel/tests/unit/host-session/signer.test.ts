import { describe, expect, it } from 'bun:test';
import { createIdentitySigner } from '../../../host/session/signer.ts';
import {
  claimTranscript,
  concatBytes,
  decodeClaim,
  fromBase64UrlFixed,
  lengthPrefixed,
  NONCE_BYTES,
  toBase64Url,
  tunnelTranscript,
  utf8Bytes,
  verifyRendezvousClaim,
  verifyTunnelRequest,
} from '../../../host/session/wire/index.ts';
import { newDaemonIdentity, relayCrypto } from './identities.ts';

const host = 'relay.example.test';
const nonceText = (): string => toBase64Url(relayCrypto.randomBytes(NONCE_BYTES));
const be32 = (value: number): Uint8Array =>
  new Uint8Array([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);

describe('identity signer: the rendezvous claim', () => {
  it('signs the claim layout: label (not length-prefixed), then LP(protocol), LP(daemonId), LP(host), LP(nonce)', async () => {
    const identity = await newDaemonIdentity();
    const nonce = relayCrypto.randomBytes(NONCE_BYTES);
    const expected = concatBytes([
      utf8Bytes('ferretry-relay-claim-v1'),
      be32(16),
      utf8Bytes('ferretry-relay/1'),
      be32(identity.daemonId.length),
      utf8Bytes(identity.daemonId),
      be32(host.length),
      utf8Bytes(host),
      be32(NONCE_BYTES),
      nonce,
    ]);
    expect(claimTranscript({ daemonId: identity.daemonId, relayHost: host, challenge: nonce })).toEqual(expected);
    const signed = await createIdentitySigner(identity).sign({ host, nonce: toBase64Url(nonce) });
    expect(signed.daemonId).toBe(identity.daemonId);
    expect(signed.publicKey).toBe(toBase64Url(identity.publicKeySpki));
    const signature = fromBase64UrlFixed(signed.signature, 64) as Uint8Array;
    expect(await relayCrypto.verifyEd25519(identity.publicKeySpki, signature, expected)).toBe(true);
  });

  it('a signed claim verifies with the existing verifier; a wrong host or nonce is refused', async () => {
    const identity = await newDaemonIdentity();
    const nonce = nonceText();
    const signed = await createIdentitySigner(identity).sign({ host, nonce });
    const claim = decodeClaim(signed.publicKey, signed.signature);
    expect(claim).not.toBeNull();
    const challenge = fromBase64UrlFixed(nonce, NONCE_BYTES) as Uint8Array;
    const context = { daemonId: identity.daemonId, relayHost: host, challenge };
    expect((await verifyRendezvousClaim(relayCrypto, context, claim!)).ok).toBe(true);
    expect((await verifyRendezvousClaim(relayCrypto, { ...context, relayHost: 'evil.test' }, claim!)).ok).toBe(false);
    const otherNonce = fromBase64UrlFixed(nonceText(), NONCE_BYTES) as Uint8Array;
    expect((await verifyRendezvousClaim(relayCrypto, { ...context, challenge: otherNonce }, claim!)).ok).toBe(false);
  });

  it('refuses a malformed nonce or an empty host before signing anything', async () => {
    const identity = await newDaemonIdentity();
    let signed = 0;
    const counted = { ...identity, sign: async (bytes: Uint8Array) => ((signed += 1), await identity.sign(bytes)) };
    const signer = createIdentitySigner(counted);
    await expect(signer.sign({ host, nonce: 'short' })).rejects.toThrow(TypeError);
    await expect(signer.sign({ host, nonce: `${nonceText()}=` })).rejects.toThrow(TypeError);
    await expect(signer.sign({ host: '', nonce: nonceText() })).rejects.toThrow(TypeError);
    expect(signed).toBe(0);
  });

  it('offers no way to read the key: the signer has exactly sign and signTunnel', async () => {
    const signer = createIdentitySigner(await newDaemonIdentity());
    expect(Object.keys(signer).sort()).toEqual(['sign', 'signTunnel']);
    expect(Object.isFrozen(signer)).toBe(true);
  });
});

describe('identity signer: tunnel requests', () => {
  const todaysTranscript = (label: string, daemonId: string, nonce: Uint8Array, port: string): Uint8Array =>
    concatBytes([
      utf8Bytes(label),
      lengthPrefixed(utf8Bytes('ferretry-tunnel/1')),
      lengthPrefixed(utf8Bytes(daemonId)),
      lengthPrefixed(utf8Bytes(host)),
      lengthPrefixed(nonce),
      lengthPrefixed(utf8Bytes(port)),
    ]);

  it('a provision signs today’s exact transcript, with the origin port, and verifies', async () => {
    const identity = await newDaemonIdentity();
    const nonce = relayCrypto.randomBytes(NONCE_BYTES);
    const signed = await createIdentitySigner(identity).signTunnel({
      action: 'provision',
      host,
      nonce: toBase64Url(nonce),
      originPort: 8443,
    });
    expect(signed).toMatchObject({
      daemonId: identity.daemonId,
      nonce: toBase64Url(nonce),
      publicKey: toBase64Url(identity.publicKeySpki),
    });
    const expected = todaysTranscript('ferretry-tunnel-provision-v1', identity.daemonId, nonce, '8443');
    expect(
      tunnelTranscript({ action: 'provision', daemonId: identity.daemonId, host, nonce, originPort: 8443 }),
    ).toEqual(expected);
    const signature = fromBase64UrlFixed(signed.signature, 64) as Uint8Array;
    expect(await relayCrypto.verifyEd25519(identity.publicKeySpki, signature, expected)).toBe(true);
    const context = { action: 'provision' as const, daemonId: identity.daemonId, host, nonce, originPort: 8443 };
    expect(await verifyTunnelRequest(relayCrypto, context, signed)).toEqual({ ok: true });
    // A port changed in between redirects the ingress: refused.
    expect((await verifyTunnelRequest(relayCrypto, { ...context, originPort: 9000 }, signed)).ok).toBe(false);
  });

  it('a release signs today’s exact transcript (empty port) and verifies', async () => {
    const identity = await newDaemonIdentity();
    const nonce = relayCrypto.randomBytes(NONCE_BYTES);
    const signed = await createIdentitySigner(identity).signTunnel({
      action: 'release',
      host,
      nonce: toBase64Url(nonce),
    });
    const expected = todaysTranscript('ferretry-tunnel-release-v1', identity.daemonId, nonce, '');
    const signature = fromBase64UrlFixed(signed.signature, 64) as Uint8Array;
    expect(await relayCrypto.verifyEd25519(identity.publicKeySpki, signature, expected)).toBe(true);
    expect(
      await verifyTunnelRequest(relayCrypto, { action: 'release', daemonId: identity.daemonId, host, nonce }, signed),
    ).toEqual({
      ok: true,
    });
  });

  it('a provision signature does not verify as a release, nor as a rendezvous claim', async () => {
    const identity = await newDaemonIdentity();
    const nonce = relayCrypto.randomBytes(NONCE_BYTES);
    const signer = createIdentitySigner(identity);
    const signed = await signer.signTunnel({ action: 'provision', host, nonce: toBase64Url(nonce) });
    const asRelease = { action: 'release' as const, daemonId: identity.daemonId, host, nonce };
    expect((await verifyTunnelRequest(relayCrypto, asRelease, signed)).ok).toBe(false);
    const claim = decodeClaim(signed.publicKey, signed.signature)!;
    const asClaim = { daemonId: identity.daemonId, relayHost: host, challenge: nonce };
    expect((await verifyRendezvousClaim(relayCrypto, asClaim, claim)).ok).toBe(false);
  });

  it('refuses an unknown action, a bad port or a malformed nonce', async () => {
    const signer = createIdentitySigner(await newDaemonIdentity());
    const nonce = nonceText();
    await expect(signer.signTunnel({ action: 'delete' as 'release', host, nonce })).rejects.toThrow(TypeError);
    await expect(signer.signTunnel({ action: 'provision', host, nonce, originPort: 0 })).rejects.toThrow(TypeError);
    await expect(signer.signTunnel({ action: 'provision', host, nonce, originPort: 1.5 })).rejects.toThrow(TypeError);
    await expect(signer.signTunnel({ action: 'release', host, nonce: 'AAAA' })).rejects.toThrow(TypeError);
  });
});
