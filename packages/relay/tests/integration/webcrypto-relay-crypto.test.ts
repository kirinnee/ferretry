import { describe, it } from 'bun:test';
import { RelayKeyHandleError, WebCryptoRelayCrypto } from '../../src/adapters/index.ts';
import { AEAD_KEY_BYTES, AEAD_NONCE_BYTES, utf8Bytes } from '../../src/lib/index.ts';
import should from 'should';
import { newDaemonIdentity, relayCrypto, toPem } from '../support/identities.ts';

describe('WebCrypto relay crypto', () => {
  it('should produce random bytes of the width asked for', () => {
    should(relayCrypto.randomBytes(32).length).equal(32);
    should(relayCrypto.randomBytes(32)).not.deepEqual(relayCrypto.randomBytes(32));
  });

  it('should hash to the digest both sides of a handshake will compute', async () => {
    const digest = await relayCrypto.sha256(utf8Bytes('ferretry'));
    should(digest.length).equal(32);
    should(await relayCrypto.sha256(utf8Bytes('ferretry'))).deepEqual(digest);
  });

  it('should agree on a shared secret from two ephemeral key pairs', async () => {
    const [ours, theirs] = await Promise.all([
      relayCrypto.generateEphemeralKeyPair(),
      relayCrypto.generateEphemeralKeyPair(),
    ]);
    should(ours.publicKey.length).equal(32);
    const forward = await relayCrypto.deriveSharedSecret(ours.privateKey, theirs.publicKey);
    const backward = await relayCrypto.deriveSharedSecret(theirs.privateKey, ours.publicKey);
    should(forward).deepEqual(backward);
  });

  it('should refuse a peer key it cannot use, and a secret that is all zeroes', async () => {
    const ours = await relayCrypto.generateEphemeralKeyPair();
    should(await relayCrypto.deriveSharedSecret(ours.privateKey, new Uint8Array(4))).be.null();
    // A low-order point drives X25519 to an all-zero secret, which is never a usable key.
    should(await relayCrypto.deriveSharedSecret(ours.privateKey, new Uint8Array(32))).be.null();
  });

  it('should derive distinct keys for distinct labels', async () => {
    const secret = relayCrypto.randomBytes(32);
    const salt = relayCrypto.randomBytes(32);
    const first = await relayCrypto.deriveKey(secret, salt, 'one', AEAD_KEY_BYTES);
    const second = await relayCrypto.deriveKey(secret, salt, 'two', AEAD_KEY_BYTES);
    should(first.length).equal(AEAD_KEY_BYTES);
    should(first).not.deepEqual(second);
    should(await relayCrypto.deriveKey(secret, salt, 'one', AEAD_KEY_BYTES)).deepEqual(first);
  });

  it('should sign with an identity and verify against its public key', async () => {
    const identity = await newDaemonIdentity();
    const message = utf8Bytes('claim me');
    const signature = await relayCrypto.signEd25519(identity.privateKey, message);
    should(signature.length).equal(64);
    should(await relayCrypto.verifyEd25519(identity.publicKeySpki, signature, message)).be.true();
    should(await relayCrypto.verifyEd25519(identity.publicKeySpki, signature, utf8Bytes('something else'))).be.false();
    should(await relayCrypto.verifyEd25519(new Uint8Array(44), signature, message)).be.false();
  });

  it('should seal and open, and refuse anything altered', async () => {
    const key = relayCrypto.randomBytes(AEAD_KEY_BYTES);
    const nonce = relayCrypto.randomBytes(AEAD_NONCE_BYTES);
    const associated = utf8Bytes('header');
    const sealed = await relayCrypto.seal(key, nonce, associated, utf8Bytes('payload'));
    should(await relayCrypto.open(key, nonce, associated, sealed)).deepEqual(utf8Bytes('payload'));
    should(await relayCrypto.open(key, nonce, utf8Bytes('other header'), sealed)).be.null();

    const tampered = Uint8Array.from(sealed);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    should(await relayCrypto.open(key, nonce, associated, tampered)).be.null();
  });

  it('should refuse a key handle it did not mint', async () => {
    const foreign = { algorithm: 'Ed25519' } as const;
    await should(relayCrypto.signEd25519(foreign, utf8Bytes('x'))).be.rejectedWith(RelayKeyHandleError);
    await should(relayCrypto.deriveSharedSecret({ algorithm: 'X25519' }, new Uint8Array(32))).be.rejectedWith(
      RelayKeyHandleError,
    );
  });

  it('should load a daemon identity from the PEM the daemon stored', async () => {
    const identity = await newDaemonIdentity();
    should(identity.publicKeySpki.length).equal(44);
    should(identity.daemonId).match(/^fy_daemon_[A-Za-z0-9_-]{43}$/u);
    const signature = await relayCrypto.signEd25519(identity.privateKey, utf8Bytes('proof'));
    should(await relayCrypto.verifyEd25519(identity.publicKeySpki, signature, utf8Bytes('proof'))).be.true();
  });

  it('should refuse identity material that is not a usable key', async () => {
    await should(
      relayCrypto.importDaemonIdentity('-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n'),
    ).be.rejectedWith(RelayKeyHandleError);

    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as unknown as CryptoKeyPair;
    const pem = toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey));

    const withoutPublicHalf = new WebCryptoRelayCrypto({
      ...crypto.subtle,
      importKey: crypto.subtle.importKey.bind(crypto.subtle),
      exportKey: async () => ({}),
    } as unknown as SubtleCrypto);
    await should(withoutPublicHalf.importDaemonIdentity(pem)).be.rejectedWith(RelayKeyHandleError);

    const withShortPublicHalf = new WebCryptoRelayCrypto({
      ...crypto.subtle,
      digest: crypto.subtle.digest.bind(crypto.subtle),
      importKey: crypto.subtle.importKey.bind(crypto.subtle),
      exportKey: async () => ({ x: 'AAAA' }),
    } as unknown as SubtleCrypto);
    await should(withShortPublicHalf.importDaemonIdentity(pem)).be.rejectedWith(RelayKeyHandleError);
  });
});
