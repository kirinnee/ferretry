import {
  AEAD_KEY_BYTES,
  AEAD_NONCE_BYTES,
  type CloneCrypto,
  ED25519_SIGNATURE_BYTES,
  fromBase64Url,
  fromBase64UrlFixed,
  publicKeyMatchesDaemonId,
  toBase64Url,
  utf8Bytes,
  X25519_PUBLIC_KEY_BYTES,
} from '@ferretry/std/sealing';
import {
  BUNDLE_KEY_LABEL,
  type BundleHeader,
  chunkAssociatedData,
  offerSignedBytes,
  RELOCATE_FORMAT,
  type RelocateOffer,
} from '../../contract/index.ts';

/** How far apart two machines' clocks may be before an offer reads as expired or overlong. */
const CLOCK_SKEW_MS = 60_000;
/** The longest an offer may claim to stay open: the target's own bound, plus skew. */
const OFFER_TTL_MS = 5 * 60_000;

/** A refusal with one sentence a person can read, and a closed code the app words. */
export class OfferRefused extends Error {
  constructor(
    readonly code: 'offer_expired' | 'offer_invalid' | 'same_machine' | 'offer_spent',
    message: string,
  ) {
    super(message);
    this.name = 'OfferRefused';
  }
}

/**
 * The offer's X25519 key, once its fingerprint, its signature and its expiry hold, and it is for another machine. Nothing is
 * sealed to a key whose owner has not proved it holds the daemon identity it names.
 */
export async function verifiedOfferKey(
  crypto: CloneCrypto,
  offer: RelocateOffer,
  ownDaemonId: string,
  nowMs: number,
): Promise<Uint8Array> {
  if (offer.daemonId === ownDaemonId)
    throw new OfferRefused('same_machine', 'a machine cannot move a ferret to itself');
  const expiresAtMs = Date.parse(offer.expiresAt);
  if (expiresAtMs + CLOCK_SKEW_MS <= nowMs)
    throw new OfferRefused('offer_expired', 'the other machine’s offer timed out; open a new one there');
  if (expiresAtMs - nowMs > OFFER_TTL_MS + CLOCK_SKEW_MS)
    throw new OfferRefused('offer_invalid', 'the offer claims to stay open longer than any offer does');
  const identityKey = fromBase64Url(offer.identityKey);
  const publicKey = fromBase64UrlFixed(offer.publicKey, X25519_PUBLIC_KEY_BYTES);
  const signature = fromBase64UrlFixed(offer.signature, ED25519_SIGNATURE_BYTES);
  const { signature: _signature, ...unsigned } = offer;
  const genuine =
    identityKey !== null &&
    publicKey !== null &&
    signature !== null &&
    (await publicKeyMatchesDaemonId(crypto, identityKey, offer.daemonId)) &&
    (await crypto.verifyEd25519(identityKey, signature, offerSignedBytes(unsigned)));
  if (!genuine || publicKey === null)
    throw new OfferRefused('offer_invalid', 'the offer was not signed by the machine it names');
  return publicKey;
}

/** Cuts a list of byte runs into `size`-byte pieces without joining them first. Always at least one piece. */
function pieces(parts: readonly Uint8Array[], size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let current = new Uint8Array(size);
  let used = 0;
  for (const part of parts) {
    let offset = 0;
    while (offset < part.length) {
      const take = Math.min(size - used, part.length - offset);
      current.set(part.subarray(offset, offset + take), used);
      used += take;
      offset += take;
      if (used === size) {
        out.push(current);
        current = new Uint8Array(size);
        used = 0;
      }
    }
  }
  if (used > 0 || out.length === 0) out.push(current.slice(0, used));
  return out;
}

export interface SealedBundle {
  readonly header: BundleHeader;
  /** `nonce ‖ ciphertext‖tag` per chunk; the index is the position. */
  readonly chunks: readonly Uint8Array[];
}

/**
 * Seals `parts` (the manifest and the files, in order) to the offer's key, one authenticated chunk at a time. A fresh
 * X25519 key pair makes the bundle key and is thrown away: the source cannot open its own export again.
 */
export async function sealBundle(
  crypto: CloneCrypto,
  input: {
    readonly offer: RelocateOffer;
    readonly offerKey: Uint8Array;
    readonly sourceDaemonId: string;
    readonly parts: readonly Uint8Array[];
    readonly chunkBytes: number;
  },
): Promise<SealedBundle> {
  const ephemeral = await crypto.generateEphemeralKeyPair();
  const shared = await crypto.deriveSharedSecret(ephemeral.privateKey, input.offerKey);
  if (shared === null) throw new OfferRefused('offer_invalid', 'the offer carries a key no machine could hold');
  const key = await crypto.deriveKey(shared, utf8Bytes(input.offer.offerId), BUNDLE_KEY_LABEL, AEAD_KEY_BYTES);
  const plain = pieces(input.parts, input.chunkBytes);
  const header: BundleHeader = {
    v: RELOCATE_FORMAT,
    offerId: input.offer.offerId,
    sourceDaemonId: input.sourceDaemonId,
    targetDaemonId: input.offer.daemonId,
    expiresAt: input.offer.expiresAt,
    ephemeralKey: toBase64Url(ephemeral.publicKey),
    chunks: plain.length,
    bytes: plain.reduce((sum, piece) => sum + piece.length, 0),
  };
  const chunks: Uint8Array[] = [];
  for (const [index, piece] of plain.entries()) {
    const nonce = crypto.randomBytes(AEAD_NONCE_BYTES);
    const sealed = await crypto.seal(key, nonce, chunkAssociatedData(header, index), piece);
    const joined = new Uint8Array(nonce.length + sealed.length);
    joined.set(nonce, 0);
    joined.set(sealed, nonce.length);
    chunks.push(joined);
  }
  return { header, chunks };
}
