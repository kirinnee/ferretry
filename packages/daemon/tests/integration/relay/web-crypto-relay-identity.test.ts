/**
 * The two spellings of one fingerprint, held to the same answer.
 *
 * Pairing computes the `daemonId` with Node's crypto over the SubjectPublicKeyInfo; the relay claim
 * computes it with WebCrypto over the same bytes. If those two ever disagreed the daemon would claim a
 * rendezvous under one name and hand out a QR code carrying another, and every browser that pinned the
 * QR would refuse the handshake — correctly, and unfixably from the outside. So the test is not "does
 * it import a key": it is "do both halves of this product agree what this daemon is called".
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { NodePairingCryptography } from '../../../src/adapters/pairing/node-pairing-cryptography.ts';
import { WebCryptoRelayIdentityKeys } from '../../../src/adapters/relay/web-crypto-relay-identity.ts';

describe('the identity the relay claim signs with', () => {
  it('should be the same key, and the same fingerprint, that pairing put in the QR code', async () => {
    // Arrange — exactly what pairing mints and stores on a daemon's first boot.
    const minted = new NodePairingCryptography().newIdentity();

    // Act
    const identity = await new WebCryptoRelayIdentityKeys().load(minted.privateKeyPem);

    // Assert
    should(identity.daemonId).equal(minted.daemonId);
    should(identity.publicKeySpki.length).equal(44);
    should(identity.privateKey.algorithm).equal('Ed25519');
  });

  it('should refuse a document that is not a private key rather than answering with an identity', async () => {
    // Act + Assert
    await should(new WebCryptoRelayIdentityKeys().load('not a pem at all')).be.rejected();
  });
});
