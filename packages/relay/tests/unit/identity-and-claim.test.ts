import { describe, it } from 'bun:test';
import {
  claimContextForChallenge,
  claimTranscript,
  daemonIdFromPublicKey,
  decodeClaim,
  encodeClaim,
  NONCE_BYTES,
  parseDaemonId,
  publicKeyMatchesDaemonId,
  signRendezvousClaim,
  toBase64Url,
  verifyRendezvousClaim,
} from '@ferretry/relay';
import should from 'should';
import { newDaemonIdentity, relayCrypto } from '../support/identities.ts';

const host = 'relay.example.test';

describe('daemon identity', () => {
  it('should compute the fingerprint the pairing code already carries', async () => {
    const identity = await newDaemonIdentity();
    should(identity.daemonId).match(/^fy_daemon_[A-Za-z0-9_-]{43}$/u);
    should(await daemonIdFromPublicKey(relayCrypto, identity.publicKeySpki)).equal(identity.daemonId);
    should(await publicKeyMatchesDaemonId(relayCrypto, identity.publicKeySpki, identity.daemonId)).be.true();
  });

  it('should refuse key material and identifiers that are not the right shape', async () => {
    const identity = await newDaemonIdentity();
    should(await daemonIdFromPublicKey(relayCrypto, new Uint8Array(43))).be.null();
    should(parseDaemonId('fy_daemon_too-short')).be.null();
    should(await publicKeyMatchesDaemonId(relayCrypto, identity.publicKeySpki, 'nonsense')).be.false();
    should(await publicKeyMatchesDaemonId(relayCrypto, new Uint8Array(43), identity.daemonId)).be.false();
  });

  it('should reject a key that hashes to a different fingerprint', async () => {
    const [mine, theirs] = await Promise.all([newDaemonIdentity(), newDaemonIdentity()]);
    should(await publicKeyMatchesDaemonId(relayCrypto, theirs.publicKeySpki, mine.daemonId)).be.false();
  });
});

describe('rendezvous claim', () => {
  it('should let the key holder claim its own rendezvous', async () => {
    const identity = await newDaemonIdentity();
    const challenge = relayCrypto.randomBytes(NONCE_BYTES);
    const context = { daemonId: identity.daemonId, relayHost: host, challenge };
    const claim = await signRendezvousClaim(relayCrypto, identity, context);
    const verdict = await verifyRendezvousClaim(relayCrypto, context, claim);
    should(verdict.ok).be.true();
    if (verdict.ok) should(verdict.publicKeySpki).deepEqual(identity.publicKeySpki);
  });

  it('should refuse a claim signed for a different host, challenge or rendezvous', async () => {
    const identity = await newDaemonIdentity();
    const challenge = relayCrypto.randomBytes(NONCE_BYTES);
    const context = { daemonId: identity.daemonId, relayHost: host, challenge };
    const claim = await signRendezvousClaim(relayCrypto, identity, context);

    const otherHost = await verifyRendezvousClaim(relayCrypto, { ...context, relayHost: 'evil.test' }, claim);
    should(otherHost.ok).be.false();

    const otherChallenge = await verifyRendezvousClaim(
      relayCrypto,
      { ...context, challenge: relayCrypto.randomBytes(NONCE_BYTES) },
      claim,
    );
    should(otherChallenge.ok).be.false();
    if (!otherChallenge.ok) should(otherChallenge.reason).match(/signature failed/u);
  });

  it('should refuse a key that does not match the fingerprint being claimed', async () => {
    const [mine, squatter] = await Promise.all([newDaemonIdentity(), newDaemonIdentity()]);
    const challenge = relayCrypto.randomBytes(NONCE_BYTES);
    const context = { daemonId: mine.daemonId, relayHost: host, challenge };
    const claim = await signRendezvousClaim(relayCrypto, squatter, { ...context, daemonId: squatter.daemonId });
    const verdict = await verifyRendezvousClaim(relayCrypto, context, claim);
    should(verdict.ok).be.false();
    if (!verdict.ok) should(verdict.reason).match(/does not match the rendezvous fingerprint/u);
  });

  it('should refuse malformed claim material before it reaches a verifier', async () => {
    const identity = await newDaemonIdentity();
    const challenge = relayCrypto.randomBytes(NONCE_BYTES);
    const context = { daemonId: identity.daemonId, relayHost: host, challenge };
    const claim = await signRendezvousClaim(relayCrypto, identity, context);

    const shortChallenge = await verifyRendezvousClaim(
      relayCrypto,
      { ...context, challenge: new Uint8Array(4) },
      claim,
    );
    should(shortChallenge.ok).be.false();

    const shortKey = await verifyRendezvousClaim(relayCrypto, context, { ...claim, publicKeySpki: new Uint8Array(4) });
    should(shortKey.ok).be.false();

    const shortSignature = await verifyRendezvousClaim(relayCrypto, context, {
      ...claim,
      signature: new Uint8Array(4),
    });
    should(shortSignature.ok).be.false();
  });

  it('should round-trip a claim through its wire spelling', async () => {
    const identity = await newDaemonIdentity();
    const challenge = relayCrypto.randomBytes(NONCE_BYTES);
    const claim = await signRendezvousClaim(relayCrypto, identity, {
      daemonId: identity.daemonId,
      relayHost: host,
      challenge,
    });
    const wire = encodeClaim(claim);
    should(decodeClaim(wire.publicKey, wire.signature)).deepEqual(claim);
    should(decodeClaim('short', wire.signature)).be.null();
    should(decodeClaim(wire.publicKey, 'short')).be.null();
  });

  it('should refuse to sign for a host the daemon did not configure', () => {
    const challenge = new Uint8Array(NONCE_BYTES);
    const daemonId = `fy_daemon_${'a'.repeat(43)}`;
    should(claimContextForChallenge(daemonId, host, host, challenge)).deepEqual({
      daemonId,
      relayHost: host,
      challenge,
    });
    should(claimContextForChallenge(daemonId, host, 'somewhere.else', challenge)).be.null();
    should(claimContextForChallenge(daemonId, '', '', challenge)).be.null();
  });

  it('should bind every field of the transcript', () => {
    const challenge = new Uint8Array(NONCE_BYTES).fill(1);
    const base = { daemonId: `fy_daemon_${'a'.repeat(43)}`, relayHost: host, challenge };
    const shifted = { ...base, relayHost: `${host}x` };
    should(toBase64Url(claimTranscript(base))).not.equal(toBase64Url(claimTranscript(shifted)));
  });
});
