/**
 * The crypto port Catalogs' relay wire stands on, over the platform's real WebCrypto: hashing, an X25519 agreement, the
 * key derivation, Ed25519 signatures and AES-GCM sealing, each proved against the primitive itself rather than a double.
 * Only where a refusal can come from nothing but a platform that misbehaves is one primitive replaced, and only that one.
 */
import { describe, expect, it } from 'bun:test';
import { WebCryptoSessionCrypto } from '../../../daemon/adapters/web-crypto.ts';

const crypto_ = new WebCryptoSessionCrypto();
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

async function newPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const body = btoa(String.fromCharCode(...der)).match(/.{1,64}/gu) ?? [];
  return ['-----BEGIN PRIVATE KEY-----', ...body, '-----END PRIVATE KEY-----', ''].join('\n');
}

/** The platform's own subtle, except that exporting a JWK says what `jwk` says. */
const subtleExporting = (jwk: { x?: string }): SubtleCrypto =>
  new Proxy(crypto.subtle, {
    get: (target, property) => {
      if (property === 'exportKey')
        return async (format: string, key: CryptoKey) =>
          format === 'jwk' ? jwk : await target.exportKey(format as 'raw', key);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

describe('hashing and randomness', () => {
  it('hashes with SHA-256', async () => {
    expect(hex(await crypto_.sha256(text('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('draws as many random bytes as asked, never the same twice', () => {
    const first = crypto_.randomBytes(32);

    expect(first).toHaveLength(32);
    expect(hex(first)).not.toBe(hex(crypto_.randomBytes(32)));
  });
});

describe('an X25519 agreement', () => {
  it('gives both ends the same secret, and refuses a malformed or a low-order peer key', async () => {
    const ours = await crypto_.generateEphemeralKeyPair();
    const theirs = await crypto_.generateEphemeralKeyPair();

    const a = await crypto_.deriveSharedSecret(ours.privateKey, theirs.publicKey);
    const b = await crypto_.deriveSharedSecret(theirs.privateKey, ours.publicKey);

    expect(a).not.toBeNull();
    expect(hex(a as Uint8Array)).toBe(hex(b as Uint8Array));
    expect(await crypto_.deriveSharedSecret(ours.privateKey, new Uint8Array(5))).toBeNull();
    expect(await crypto_.deriveSharedSecret(ours.privateKey, new Uint8Array(32))).toBeNull();
  });

  it('derives a key of the length asked, the same from the same inputs and another for another label', async () => {
    const secret = text('a shared secret of some length');
    const salt = text('salt');

    const one = await crypto_.deriveKey(secret, salt, 'label-one', 32);

    expect(one).toHaveLength(32);
    expect(hex(await crypto_.deriveKey(secret, salt, 'label-one', 32))).toBe(hex(one));
    expect(hex(await crypto_.deriveKey(secret, salt, 'label-two', 32))).not.toBe(hex(one));
    expect(await crypto_.deriveKey(secret, salt, 'label-one', 12)).toHaveLength(12);
  });
});

describe('Ed25519 identity and signatures', () => {
  it('loads a daemon identity from its PEM and signs what its public half verifies', async () => {
    const identity = await crypto_.importDaemonIdentity(await newPem());

    const signature = await crypto_.signEd25519(identity.privateKey, text('the message'));

    expect(identity.daemonId.length).toBeGreaterThan(0);
    expect(await crypto_.verifyEd25519(identity.publicKeySpki, signature, text('the message'))).toBe(true);
    expect(await crypto_.verifyEd25519(identity.publicKeySpki, signature, text('another message'))).toBe(false);
  });

  it('reads a key that will not import as a failed verification, not an exception', async () => {
    const identity = await crypto_.importDaemonIdentity(await newPem());
    const signature = await crypto_.signEd25519(identity.privateKey, text('m'));

    expect(await crypto_.verifyEd25519(new Uint8Array(3), signature, text('m'))).toBe(false);
  });

  it('refuses a document that is not a PEM, and a key handle that did not come from this adapter', async () => {
    await expect(
      crypto_.importDaemonIdentity('-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n'),
    ).rejects.toThrow('identity key is not a PEM document');
    const agreement = await crypto_.generateEphemeralKeyPair();

    await expect(crypto_.signEd25519(agreement.privateKey, text('m'))).rejects.toThrow(
      'expected a Ed25519 key handle from this adapter',
    );
    await expect(crypto_.signEd25519({ algorithm: 'Ed25519', key: 'not a key' } as never, text('m'))).rejects.toThrow(
      'expected a Ed25519 key handle',
    );
  });

  it('refuses an identity whose key exposes no public half, or one that is not a usable public key', async () => {
    const pem = await newPem();

    await expect(new WebCryptoSessionCrypto(subtleExporting({})).importDaemonIdentity(pem)).rejects.toThrow(
      'identity key exposes no public half',
    );
    await expect(new WebCryptoSessionCrypto(subtleExporting({ x: 'AAAA' })).importDaemonIdentity(pem)).rejects.toThrow(
      'identity key public half is not a usable Ed25519 key',
    );
  });

  it('makes a device key that signs but whose private half cannot be exported', async () => {
    const device = await crypto_.generateDeviceKey();

    const signature = await crypto_.signEd25519(crypto_.deviceKeyHandle(device.privateKey), text('step-up'));

    expect(await crypto_.verifyEd25519(device.publicKeySpki, signature, text('step-up'))).toBe(true);
    await expect(crypto.subtle.exportKey('pkcs8', device.privateKey)).rejects.toThrow();
  });
});

describe('AES-GCM sealing', () => {
  const key = new Uint8Array(32).fill(7);
  const nonce = new Uint8Array(12).fill(3);

  it('opens what it sealed under the same key, nonce and associated data', async () => {
    const sealed = await crypto_.seal(key, nonce, text('aad'), text('a secret'));

    expect(sealed.length).toBeGreaterThan('a secret'.length);
    expect(await crypto_.open(key, nonce, text('aad'), sealed)).toEqual(text('a secret'));
  });

  it('opens nothing that was altered, sealed for other associated data, or opened with another key', async () => {
    const sealed = await crypto_.seal(key, nonce, text('aad'), text('a secret'));
    const altered = new Uint8Array(sealed);
    altered[0] = (altered[0] ?? 0) ^ 0xff;

    expect(await crypto_.open(key, nonce, text('aad'), altered)).toBeNull();
    expect(await crypto_.open(key, nonce, text('other'), sealed)).toBeNull();
    expect(await crypto_.open(new Uint8Array(32).fill(8), nonce, text('aad'), sealed)).toBeNull();
  });
});
