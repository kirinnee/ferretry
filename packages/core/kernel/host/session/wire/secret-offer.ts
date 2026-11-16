/**
 * The signed bytes of a secret-import offer (docs/secrets.md "Copying secrets to another machine"), copied from
 * today's `packages/daemon/src/lib/secrets/clone.ts` `offerSignedBytes`, byte for byte: every field, the label first,
 * length-prefixed, so no field's end can become the next one's start. The label keeps an offer signature from ever
 * being replayed as a relay claim, a catalog signature or a handshake, or the reverse. The offer itself, its expiry
 * and the sealed bundle are the Vault's.
 */

import { concatBytes, fromBase64Url, fromBase64UrlFixed, lengthPrefixed, utf8Bytes } from './binary.ts';
import { ED25519_SIGNATURE_BYTES } from './constants.ts';
import type { SessionCrypto } from './crypto.ts';
import { publicKeyMatchesDaemonId } from './identity.ts';

/** Domain separation: an offer signature can never be replayed as a relay claim, or the reverse. */
export const SECRET_OFFER_SIGNATURE_LABEL = 'ferretry-secret-import-offer-v1' as const;

/** The offer fields the signature covers (today's `Omit<SecretImportOffer, 'signature'>`). */
export interface SecretOfferFields {
  readonly v: number;
  readonly importId: string;
  readonly daemonId: string;
  /** The target's Ed25519 daemon identity, SPKI DER, base64url. */
  readonly identityKey: string;
  /** The import's one-time X25519 public key, base64url. */
  readonly publicKey: string;
  readonly expiresAt: string;
}

/** `LP(label) ‖ LP(v) ‖ LP(importId) ‖ LP(daemonId) ‖ LP(identityKey) ‖ LP(publicKey) ‖ LP(expiresAt)`, UTF-8. */
export function secretOfferSignedBytes(offer: SecretOfferFields): Uint8Array {
  return concatBytes(
    [
      SECRET_OFFER_SIGNATURE_LABEL,
      String(offer.v),
      offer.importId,
      offer.daemonId,
      offer.identityKey,
      offer.publicKey,
      offer.expiresAt,
    ].map(field => lengthPrefixed(utf8Bytes(field))),
  );
}

/**
 * Whether `signature` is `identityKey` signing these offer fields AND that key hashes to the `daemonId` the offer
 * names (today's `#verifiedOfferKey` signature half; the expiry checks stay the Vault's).
 */
export async function verifySecretOfferSignature(
  crypto: SessionCrypto,
  offer: SecretOfferFields & { readonly signature: string },
): Promise<boolean> {
  const identityKey = fromBase64Url(offer.identityKey);
  const signature = fromBase64UrlFixed(offer.signature, ED25519_SIGNATURE_BYTES);
  if (identityKey === null || signature === null) return false;
  if (!(await publicKeyMatchesDaemonId(crypto, identityKey, offer.daemonId))) return false;
  const { signature: _signature, ...fields } = offer;
  return await crypto.verifyEd25519(identityKey, signature, secretOfferSignedBytes(fields));
}
