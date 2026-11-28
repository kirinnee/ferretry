/**
 * The signed bytes of a move-to-another-machine offer (docs/machine-move.md), byte for byte what
 * `plugins/relocate/contract/seal-format.ts` `offerSignedBytes` builds for the source's check: every field, the label
 * first, length-prefixed, so no field's end can become the next one's start. The label keeps a move offer from ever
 * being replayed as a secrets offer, a relay claim or a catalog signature, or the reverse.
 */

import { concatBytes, lengthPrefixed, utf8Bytes } from './binary.ts';

/** Domain separation: a move offer's signature can never be replayed as another signature of this identity. */
export const RELOCATE_OFFER_SIGNATURE_LABEL = 'ferretry-relocate-offer-v1' as const;

/** The offer fields the signature covers. */
export interface RelocateOfferFields {
  readonly v: number;
  readonly offerId: string;
  readonly daemonId: string;
  /** The target's Ed25519 daemon identity, SPKI DER, base64url. */
  readonly identityKey: string;
  /** The offer's one-time X25519 public key, base64url. */
  readonly publicKey: string;
  readonly expiresAt: string;
}

/** `LP(label) ‖ LP(v) ‖ LP(offerId) ‖ LP(daemonId) ‖ LP(identityKey) ‖ LP(publicKey) ‖ LP(expiresAt)`, UTF-8. */
export function relocateOfferSignedBytes(offer: RelocateOfferFields): Uint8Array {
  return concatBytes(
    [
      RELOCATE_OFFER_SIGNATURE_LABEL,
      String(offer.v),
      offer.offerId,
      offer.daemonId,
      offer.identityKey,
      offer.publicKey,
      offer.expiresAt,
    ].map(field => lengthPrefixed(utf8Bytes(field))),
  );
}
