/**
 * The crypto port, bound to WebCrypto.
 *
 * One adapter serves every side of this protocol: a daemon on Bun, a browser, and the Worker that
 * verifies rendezvous claims. `crypto.subtle` is the only implementation in all three, and using
 * the same one everywhere is what removes an entire class of bug — two libraries that agree about
 * a primitive and disagree about an encoding.
 *
 * Private keys stay behind non-extractable `CryptoKey` handles wherever the platform allows it.
 * The one exception is importing a daemon's stored identity, which has to read the key to compute
 * the public half; that is noted where it happens.
 */

import type { DaemonIdentity, EphemeralKeyPair, PrivateKeyHandle, RelayCrypto } from '../lib/index.ts';
import { AEAD_TAG_BYTES, concatBytes, daemonIdFromPublicKey, isAllZero, SHARED_SECRET_BYTES } from '../lib/index.ts';

/** The fixed prefix of an Ed25519 SubjectPublicKeyInfo. The remaining 32 bytes are the key. */
const ED25519_SPKI_PREFIX = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

interface WebCryptoPrivateKey extends PrivateKeyHandle {
  readonly key: CryptoKey;
}

/** A key handle from another adapter is a programming error, not a runtime condition to absorb. */
export class RelayKeyHandleError extends Error {}

function handleOf(algorithm: PrivateKeyHandle['algorithm'], key: CryptoKey): WebCryptoPrivateKey {
  return { algorithm, key };
}

function keyOf(handle: PrivateKeyHandle, algorithm: PrivateKeyHandle['algorithm']): CryptoKey {
  const candidate = handle as Partial<WebCryptoPrivateKey>;
  if (candidate.algorithm !== algorithm || !(candidate.key instanceof CryptoKey)) {
    throw new RelayKeyHandleError(`expected a ${algorithm} key handle from this adapter`);
  }
  return candidate.key;
}

function bytesOf(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

/**
 * Re-home bytes onto a plain `ArrayBuffer`.
 *
 * WebCrypto will not accept a view whose buffer might be shared, and a `Uint8Array` handed in
 * from anywhere else carries no proof that it is not. The copy is a few dozen bytes for every key
 * and nonce here, and the largest thing that goes through it is one frame.
 */
function source(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export class WebCryptoRelayCrypto implements RelayCrypto {
  constructor(private readonly subtle: SubtleCrypto = crypto.subtle) {}

  randomBytes(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length));
  }

  async sha256(data: Uint8Array): Promise<Uint8Array> {
    return bytesOf(await this.subtle.digest('SHA-256', source(data)));
  }

  async generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
    const pair = await this.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    const { privateKey, publicKey } = pair as unknown as CryptoKeyPair;
    return {
      publicKey: bytesOf(await this.subtle.exportKey('raw', publicKey)),
      privateKey: handleOf('X25519', privateKey),
    };
  }

  /**
   * X25519 agreement.
   *
   * A malformed peer key and a low-order peer key are both refused rather than reported as a
   * secret: WebCrypto throws for the first and produces an all-zero secret for the second, and a
   * caller that derived keys from either would have keyed a channel to nothing at all.
   */
  async deriveSharedSecret(privateKey: PrivateKeyHandle, peerPublicKey: Uint8Array): Promise<Uint8Array | null> {
    const key = keyOf(privateKey, 'X25519');
    let secret: Uint8Array;
    try {
      const peer = await this.subtle.importKey('raw', source(peerPublicKey), { name: 'X25519' }, false, []);
      secret = bytesOf(await this.subtle.deriveBits({ name: 'X25519', public: peer }, key, SHARED_SECRET_BYTES * 8));
    } catch {
      return null;
    }
    return isAllZero(secret) ? null : secret;
  }

  async deriveKey(secret: Uint8Array, salt: Uint8Array, label: string, length: number): Promise<Uint8Array> {
    const key = await this.subtle.importKey('raw', source(secret), 'HKDF', false, ['deriveBits']);
    const info = new TextEncoder().encode(label);
    return bytesOf(
      await this.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: source(salt), info }, key, length * 8),
    );
  }

  async signEd25519(privateKey: PrivateKeyHandle, message: Uint8Array): Promise<Uint8Array> {
    return bytesOf(await this.subtle.sign({ name: 'Ed25519' }, keyOf(privateKey, 'Ed25519'), source(message)));
  }

  /** A key that will not import is a failed verification, not an exception for a caller to handle. */
  async verifyEd25519(publicKeySpki: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
    try {
      const key = await this.subtle.importKey('spki', source(publicKeySpki), { name: 'Ed25519' }, false, ['verify']);
      return await this.subtle.verify({ name: 'Ed25519' }, key, source(signature), source(message));
    } catch {
      return false;
    }
  }

  async seal(
    key: Uint8Array,
    nonce: Uint8Array,
    associatedData: Uint8Array,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    const aead = await this.aeadKey(key, 'encrypt');
    const parameters = {
      name: 'AES-GCM',
      iv: source(nonce),
      additionalData: source(associatedData),
      tagLength: AEAD_TAG_BYTES * 8,
    };
    return bytesOf(await this.subtle.encrypt(parameters, aead, source(plaintext)));
  }

  async open(
    key: Uint8Array,
    nonce: Uint8Array,
    associatedData: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array | null> {
    const aead = await this.aeadKey(key, 'decrypt');
    const parameters = {
      name: 'AES-GCM',
      iv: source(nonce),
      additionalData: source(associatedData),
      tagLength: AEAD_TAG_BYTES * 8,
    };
    try {
      return bytesOf(await this.subtle.decrypt(parameters, aead, source(ciphertext)));
    } catch {
      return null;
    }
  }

  private async aeadKey(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
    return this.subtle.importKey('raw', source(key), 'AES-GCM', false, [usage]);
  }

  /**
   * Load a daemon's stored Ed25519 identity from its PKCS#8 PEM.
   *
   * WebCrypto cannot derive a public key from a private one, so the key is imported extractable
   * once to read the public half out of its JWK, then re-imported non-extractable for signing.
   * The material is already in the caller's memory — it came off disk as PEM — so this reads a
   * value the caller already holds rather than exposing a new one.
   */
  async importDaemonIdentity(privateKeyPem: string): Promise<DaemonIdentity> {
    const der = decodePem(privateKeyPem);
    const readable = await this.subtle.importKey('pkcs8', source(der), { name: 'Ed25519' }, true, ['sign']);
    const jwk = (await this.subtle.exportKey('jwk', readable)) as { readonly x?: string };
    const publicKeySpki = spkiFromJwkX(jwk.x);
    const daemonId = await daemonIdFromPublicKey(this, publicKeySpki);
    if (daemonId === null) throw new RelayKeyHandleError('identity key public half is not a usable Ed25519 key');
    const signing = await this.subtle.importKey('pkcs8', source(der), { name: 'Ed25519' }, false, ['sign']);
    return { publicKeySpki, daemonId, privateKey: handleOf('Ed25519', signing) };
  }
}

function spkiFromJwkX(x: string | undefined): Uint8Array {
  if (x === undefined) throw new RelayKeyHandleError('identity key exposes no public half');
  const raw = Uint8Array.from(
    atob(
      x
        .replaceAll('-', '+')
        .replaceAll('_', '/')
        .padEnd(Math.ceil(x.length / 4) * 4, '='),
    ),
    character => character.charCodeAt(0),
  );
  // Length is not checked here on purpose: a wrong-sized public half produces a wrong-sized
  // SubjectPublicKeyInfo, which the fingerprint step refuses. One check, in the place that already
  // has to make it, beats two that could disagree.
  return concatBytes([ED25519_SPKI_PREFIX, raw]);
}

function decodePem(pem: string): Uint8Array {
  const body = pem
    .split('\n')
    .filter(line => !line.startsWith('-----') && line.trim() !== '')
    .join('');
  if (body === '') throw new RelayKeyHandleError('identity key is not a PEM document');
  return Uint8Array.from(atob(body), character => character.charCodeAt(0));
}
