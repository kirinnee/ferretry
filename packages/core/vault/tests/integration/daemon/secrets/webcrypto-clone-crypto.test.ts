import { describe, expect, test } from 'bun:test';
import { WebCryptoCloneCrypto } from '../../../../daemon/adapters/secrets/webcrypto-clone-crypto.ts';
import { AEAD_NONCE_BYTES, SHARED_SECRET_BYTES } from '../../../../daemon/lib/secrets/clone-crypto.ts';

/** The adapter over the platform's REAL WebCrypto: X25519, Ed25519, HKDF and AES-GCM, nothing faked. */
const adapter = new WebCryptoCloneCrypto();
const text = (value: string) => new TextEncoder().encode(value);

const pemOf = (der: ArrayBuffer): string =>
  `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----\n`;

async function identityPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return pemOf(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
}

describe('hashing and randomness', () => {
  test('random bytes are the length asked and not the same twice; sha256 is the standard digest', async () => {
    const a = adapter.randomBytes(16);
    expect(a).toHaveLength(16);
    expect(adapter.randomBytes(16)).not.toEqual(a);
    expect(Buffer.from(await adapter.sha256(text('abc'))).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('the X25519 agreement', () => {
  test('two parties derive the same secret, then the same keys from it, and a different label gives a different key', async () => {
    const alice = await adapter.generateEphemeralKeyPair();
    const bob = await adapter.generateEphemeralKeyPair();
    expect(alice.publicKey).toHaveLength(32);
    const ab = await adapter.deriveSharedSecret(alice.privateKey, bob.publicKey);
    const ba = await adapter.deriveSharedSecret(bob.privateKey, alice.publicKey);
    expect(ab).toHaveLength(SHARED_SECRET_BYTES);
    expect(ab).toEqual(ba);
    const salt = text('salt');
    const one = await adapter.deriveKey(ab as Uint8Array, salt, 'client->daemon', 32);
    expect(one).toHaveLength(32);
    expect(await adapter.deriveKey(ba as Uint8Array, salt, 'client->daemon', 32)).toEqual(one);
    expect(await adapter.deriveKey(ab as Uint8Array, salt, 'daemon->client', 32)).not.toEqual(one);
  });

  test('a malformed peer key, and a low-order one that agrees on nothing, are refused rather than reported as a secret', async () => {
    const mine = await adapter.generateEphemeralKeyPair();
    expect(await adapter.deriveSharedSecret(mine.privateKey, new Uint8Array(5))).toBeNull();
    // The all-zero point is of low order: WebCrypto answers an all-zero secret, which keys a channel to nothing.
    expect(await adapter.deriveSharedSecret(mine.privateKey, new Uint8Array(32))).toBeNull();
  });

  test('a key handle from some other adapter is a programming error, not a runtime condition', async () => {
    const peer = await adapter.generateEphemeralKeyPair();
    await expect(adapter.deriveSharedSecret({ algorithm: 'X25519' } as never, peer.publicKey)).rejects.toThrow(
      'expected a X25519 key handle from this adapter',
    );
    await expect(adapter.signEd25519({ algorithm: 'X25519', key: undefined } as never, text('m'))).rejects.toThrow(
      'expected a Ed25519 key handle from this adapter',
    );
  });
});

describe('Ed25519 identities and signatures', () => {
  test('a device key signs through a handle, its public half verifies, and a changed message or foreign key does not', async () => {
    const device = await adapter.generateDeviceKey();
    expect(device.publicKeySpki).toHaveLength(44);
    expect(device.privateKey.extractable).toBe(false);
    const handle = adapter.deviceKeyHandle(device.privateKey);
    const signature = await adapter.signEd25519(handle, text('claim'));
    expect(signature).toHaveLength(64);
    expect(await adapter.verifyEd25519(device.publicKeySpki, signature, text('claim'))).toBe(true);
    expect(await adapter.verifyEd25519(device.publicKeySpki, signature, text('other'))).toBe(false);
    const stranger = await adapter.generateDeviceKey();
    expect(await adapter.verifyEd25519(stranger.publicKeySpki, signature, text('claim'))).toBe(false);
    // A key that will not import is a failed verification, never an exception.
    expect(await adapter.verifyEd25519(new Uint8Array(3), signature, text('claim'))).toBe(false);
  });

  test('a daemon’s stored identity gives its public half and its id, and signs what its public half verifies', async () => {
    const identity = await adapter.importDaemonIdentity(await identityPem());
    expect(identity.publicKeySpki).toHaveLength(44);
    expect(identity.daemonId).toMatch(/^fy_daemon_[A-Za-z0-9_-]{43}$/u);
    const signature = await adapter.signEd25519(identity.privateKey, text('hello'));
    expect(await adapter.verifyEd25519(identity.publicKeySpki, signature, text('hello'))).toBe(true);
  });

  test('a stored identity that is not a PEM document, or is not a key at all, is refused', async () => {
    await expect(
      adapter.importDaemonIdentity('-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n'),
    ).rejects.toThrow('identity key is not a PEM document');
    await expect(adapter.importDaemonIdentity(pemOf(new Uint8Array(8).buffer))).rejects.toThrow();
  });

  test('an identity whose key exposes no public half, or a wrong-sized one, is refused', async () => {
    // The real WebCrypto, except that a JWK export answers what the test says the key exposes.
    const exposing = (jwk: object) =>
      new WebCryptoCloneCrypto(
        new Proxy(crypto.subtle, {
          get: (target, key) => {
            if (key === 'exportKey')
              return async (format: 'jwk' | 'raw', key: CryptoKey) =>
                format === 'jwk' ? jwk : await target.exportKey(format, key);
            const member: unknown = Reflect.get(target, key, target);
            return typeof member === 'function' ? member.bind(target) : member;
          },
        }),
      );
    const pem = await identityPem();
    await expect(exposing({}).importDaemonIdentity(pem)).rejects.toThrow('identity key exposes no public half');
    await expect(exposing({ x: 'AAAA' }).importDaemonIdentity(pem)).rejects.toThrow(
      'identity key public half is not a usable Ed25519 key',
    );
  });
});

describe('AES-GCM sealing', () => {
  test('a sealed message opens under the same key, nonce and associated data, and under nothing else', async () => {
    const key = adapter.randomBytes(32);
    const nonce = adapter.randomBytes(AEAD_NONCE_BYTES);
    const sealed = await adapter.seal(key, nonce, text('frame-1'), text('the plaintext'));
    expect(sealed).toHaveLength('the plaintext'.length + 16);
    expect(await adapter.open(key, nonce, text('frame-1'), sealed)).toEqual(text('the plaintext'));
    expect(await adapter.open(key, nonce, text('frame-2'), sealed)).toBeNull();
    expect(await adapter.open(adapter.randomBytes(32), nonce, text('frame-1'), sealed)).toBeNull();
    const tampered = Uint8Array.from(sealed);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(await adapter.open(key, nonce, text('frame-1'), tampered)).toBeNull();
  });
});
