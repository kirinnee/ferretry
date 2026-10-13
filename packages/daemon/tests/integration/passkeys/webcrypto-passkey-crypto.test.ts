import { describe, it } from 'bun:test';
import { utf8Bytes } from '@ferretry/relay';
import should from 'should';
import { WebCryptoPasskeyCrypto } from '../../../src/adapters/index.ts';
import { verifyAssertion, verifyRegistration } from '../../../src/lib/passkeys/index.ts';
import {
  assertion,
  ed25519Authenticator,
  es256Authenticator,
  ORIGIN,
  registration,
  rs256Authenticator,
} from '../../support/passkey-authenticator.ts';

const adapter = new WebCryptoPasskeyCrypto();

describe('WebCryptoPasskeyCrypto', () => {
  it('should hash with SHA-256', async () => {
    // Act
    const digest = await adapter.sha256(utf8Bytes('abc'));

    // Assert — the FIPS 180-2 test vector.
    should(Buffer.from(digest).toString('hex')).equal(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('should register and then assert a passkey of every accepted algorithm through the verifier', async () => {
    for (const authenticator of [
      await es256Authenticator(),
      await ed25519Authenticator(),
      await rs256Authenticator(),
    ]) {
      // Arrange
      const registered = await verifyRegistration(adapter, await registration(authenticator));
      if (!registered.ok) throw new Error(`registration refused: ${registered.reason}`);
      const input = await assertion(authenticator, { auth: { signCount: 1 } });
      const stored = { algorithm: registered.algorithm, publicKeySpki: registered.publicKeySpki, signCount: 0 };

      // Act
      const result = await verifyAssertion(adapter, { ...input, credential: stored });

      // Assert
      should(result).deepEqual({ ok: true, signCount: 1, origin: ORIGIN });
    }
  });

  it('should answer false for a signature by another key, and reject a key it cannot import', async () => {
    // Arrange
    const signer = await ed25519Authenticator();
    const stranger = await ed25519Authenticator();
    const data = utf8Bytes('authenticatorData ‖ hash');
    const signature = await signer.sign(data);

    // Act / Assert
    should(await adapter.verify(-8, signer.spki, signature, data)).be.true();
    should(await adapter.verify(-8, stranger.spki, signature, data)).be.false();
    await should(adapter.verify(-7, signer.spki, signature, data)).be.rejected();
  });

  it('should verify an ES256 signature given in raw r‖s form, as the verifier hands it over', async () => {
    // Arrange
    const authenticator = await es256Authenticator();
    const data = utf8Bytes('signed');

    // Act / Assert
    should(await adapter.verify(-7, authenticator.spki, await authenticator.signRaw(data), data)).be.true();
    should(await adapter.verify(-7, authenticator.spki, await authenticator.sign(data), data)).be.false();
  });
});
