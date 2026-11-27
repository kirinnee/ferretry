import { type DaemonIdentity, toBase64Url, WebCryptoCloneCrypto, type PrivateKeyHandle } from '@ferretry/std/sealing';
import { offerSignedBytes, type RelocateOffer } from '../../contract/index.ts';

/** The crypto both ends use, bound once: the same adapter the daemon uses. */
export const crypto = new WebCryptoCloneCrypto();

/** A fresh machine identity, as a daemon's own would be (a PKCS#8 PEM imported through the adapter). */
export async function newIdentity(): Promise<DaemonIdentity> {
  const pair = (await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----\n`;
  return await crypto.importDaemonIdentity(pem);
}

export interface TestOffer {
  readonly offer: RelocateOffer;
  /** The target's one-time private key: only the test (standing in for the target) holds it. */
  readonly privateKey: PrivateKeyHandle;
}

/** What a TARGET machine would open: a one-time X25519 key, signed with its identity. */
export async function openOffer(
  identity: DaemonIdentity,
  options: { readonly offerId?: string; readonly expiresAtMs: number; readonly tamper?: 'signature' | 'key' },
): Promise<TestOffer> {
  const keys = await crypto.generateEphemeralKeyPair();
  const unsigned = {
    v: 1 as const,
    offerId: options.offerId ?? `fy_relocate_offer_${toBase64Url(crypto.randomBytes(16))}`,
    daemonId: identity.daemonId,
    identityKey: toBase64Url(identity.publicKeySpki),
    publicKey: toBase64Url(keys.publicKey),
    expiresAt: new Date(options.expiresAtMs).toISOString() as RelocateOffer['expiresAt'],
  };
  const signature = await crypto.signEd25519(identity.privateKey, offerSignedBytes(unsigned));
  const offer: RelocateOffer = {
    ...unsigned,
    // An offer whose signed fields were changed after signing (a swapped key) must not be sealed to.
    publicKey:
      options.tamper === 'key' ? toBase64Url((await crypto.generateEphemeralKeyPair()).publicKey) : unsigned.publicKey,
    signature: toBase64Url(options.tamper === 'signature' ? new Uint8Array(64) : signature),
  };
  return { offer, privateKey: keys.privateKey };
}
