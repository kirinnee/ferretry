import { WebCryptoRelayCrypto } from '../../src/adapters/webcrypto-relay-crypto.ts';
import type { DaemonIdentity, RelayCrypto } from '../../src/lib/index.ts';

/** One adapter for every test, because the protocol is only ever proved against real primitives. */
export const relayCrypto = new WebCryptoRelayCrypto();

export function toPem(der: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n');
}

/**
 * The real adapter with one primitive replaced.
 *
 * Failure paths in the protocol are reached by making a primitive fail, never by loosening what
 * the protocol asks of it, so everything not being tested stays real.
 */
export function stubbedCrypto(overrides: Partial<RelayCrypto>): RelayCrypto {
  const base: RelayCrypto = {
    randomBytes: length => relayCrypto.randomBytes(length),
    sha256: data => relayCrypto.sha256(data),
    generateEphemeralKeyPair: () => relayCrypto.generateEphemeralKeyPair(),
    deriveSharedSecret: (key, peer) => relayCrypto.deriveSharedSecret(key, peer),
    deriveKey: (secret, salt, label, length) => relayCrypto.deriveKey(secret, salt, label, length),
    signEd25519: (key, message) => relayCrypto.signEd25519(key, message),
    verifyEd25519: (key, signature, message) => relayCrypto.verifyEd25519(key, signature, message),
    seal: (key, nonce, associated, plaintext) => relayCrypto.seal(key, nonce, associated, plaintext),
    open: (key, nonce, associated, ciphertext) => relayCrypto.open(key, nonce, associated, ciphertext),
  };
  return { ...base, ...overrides };
}

/** A fresh daemon identity, loaded the same way a daemon loads the key it stored at install. */
export async function newDaemonIdentity(): Promise<DaemonIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  return relayCrypto.importDaemonIdentity(toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey)));
}
