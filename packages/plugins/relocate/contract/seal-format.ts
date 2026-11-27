import { concatBytes, lengthPrefixed, utf8Bytes } from '@ferretry/std/sealing';
import type { BundleHeader, RelocateOffer } from './wire.ts';

/**
 * The bytes both ends of a move agree on. They are the secrets copy's format (`@ferretry/std/sealing`: X25519, then
 * HKDF-SHA256 salted with the offer id, then AES-256-GCM) with a label of its own, so an offer signed for a move can never
 * be replayed as a secrets offer and the reverse.
 */

/** Domain separation: what the target's identity signs over its offer. */
export const OFFER_SIGNATURE_LABEL = 'ferretry-relocate-offer-v1';
/** The label the bundle key is expanded under. */
export const BUNDLE_KEY_LABEL = 'ferretry-relocate-key-v1';
/** The label of the header every chunk's tag authenticates. */
export const CHUNK_HEADER_LABEL = 'ferretry-relocate-chunk-v1';

/** The SOURCE's signature binds its identity to this offer, recipient and ephemeral sealing key. */
export function bundleSignedBytes(header: Omit<BundleHeader, 'signature'>): Uint8Array {
  return concatBytes(
    [
      'ferretry-relocate-bundle-v1',
      String(header.v),
      header.offerId,
      header.sourceDaemonId,
      header.identityKey,
      header.targetDaemonId,
      header.expiresAt,
      header.ephemeralKey,
      String(header.chunks),
      String(header.bytes),
    ].map(field => lengthPrefixed(utf8Bytes(field))),
  );
}

/** The bytes an offer's signature covers, length-prefixed so no field's end can become the next one's start. */
export function offerSignedBytes(offer: Omit<RelocateOffer, 'signature'>): Uint8Array {
  return concatBytes(
    [
      OFFER_SIGNATURE_LABEL,
      String(offer.v),
      offer.offerId,
      offer.daemonId,
      offer.identityKey,
      offer.publicKey,
      offer.expiresAt,
    ].map(field => lengthPrefixed(utf8Bytes(field))),
  );
}

/**
 * The associated data of ONE chunk: the whole header and the chunk's own index. The tag therefore fails for a chunk moved
 * to another place, a chunk of another offer, a bundle cut short (the count is in it) or one sealed for another machine.
 */
export function chunkAssociatedData(header: BundleHeader, index: number): Uint8Array {
  return concatBytes(
    [
      CHUNK_HEADER_LABEL,
      String(header.v),
      header.offerId,
      header.sourceDaemonId,
      header.targetDaemonId,
      header.expiresAt,
      header.ephemeralKey,
      String(header.chunks),
      String(header.bytes),
      String(index),
    ].map(field => lengthPrefixed(utf8Bytes(field))),
  );
}
