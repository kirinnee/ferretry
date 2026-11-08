/* TODO(kernel contract): temporary byte-copy until the pure kernel wire exports land. */
/**
 * The sealed envelope a link store holds (docs/catalogs.md § Links).
 *
 * A link is one signed item. The publisher's daemon seals it under a key that lives only in the URL
 * fragment, uploads the sealed bytes to a link store, and the recipient's app or daemon opens them with
 * the same fragment. The store holds ciphertext and a hash of a fetch token; it never holds the key.
 *
 *   URL fragment    k (32 bytes), b (bundleId, 16 bytes), fp
 *   envelope        "FYL1" ‖ uint32be sequence ‖ nonce(12) ‖ AES-256-GCM(plaintext ‖ tag)
 *   key             HKDF-SHA256(secret = k, salt = bundleId, info = "ferretry-link-bundle-key-v1/" + decimal sequence)
 *   AAD             "ferretry-link-envelope-v1" ‖ 0x00 ‖ bundleId(16) ‖ uint32be sequence
 *   plaintext       uint32be L ‖ canonical JSON of the bundle (L bytes) ‖ zero padding to a multiple of 16 KiB
 *
 * A key per sequence means a refresh never reuses a (key, nonce) pair even if a nonce repeated, and the
 * AAD binds an envelope to the one link and the one sequence it was sealed for, so a store cannot serve
 * one link's bytes at another URL or an old sequence as a new one. Padding hides the exact size of a
 * well-known public skill from the operator.
 *
 * Pure and `SessionCrypto` only, so the daemon, the PWA and the CLI run the same code.
 */
import { concatBytes, fromBase64UrlFixed, toBase64Url, utf8Bytes, writeUint32 } from '../kernel-wire/index.ts';
import type { SessionCrypto } from '../kernel-wire/index.ts';

/** First four bytes of every envelope: the format and its version. */
const LINK_ENVELOPE_MAGIC = 'FYL1' as const;
/** Domain-separates the envelope's AEAD key from every other key derived from the same secret. */
export const LINK_BUNDLE_KEY_LABEL = 'ferretry-link-bundle-key-v1' as const;
/** Domain-separates the fetch token from the envelope key. */
export const LINK_FETCH_TOKEN_LABEL = 'ferretry-link-fetch-v1' as const;
/** The first bytes of the associated data, ended by a zero byte. */
export const LINK_ENVELOPE_AAD_LABEL = 'ferretry-link-envelope-v1' as const;

/** The plaintext is padded to a multiple of this, so the operator sees a size class rather than a size. */
const LINK_PADDING_BUCKET_BYTES = 16 * 1024;
/** The largest envelope anything accepts: a 2 MiB skill, JSON escaping, the signed document and padding. */
export const LINK_ENVELOPE_MAX_BYTES = 3 * 1024 * 1024;

const LINK_SECRET_BYTES = 32;
const LINK_BUNDLE_ID_BYTES = 16;
const LINK_FETCH_TOKEN_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = LINK_ENVELOPE_MAGIC.length + 4 + NONCE_BYTES;
/** The least an envelope can be: header, one padding bucket and the tag. */

/** What a link is made of that only its holders know: the key and the store's name for the bundle. */
export interface LinkSecrets {
  /** 32 random bytes, base64url: lives in the URL fragment only. */
  readonly key: string;
  /** 16 random bytes, base64url: the store's name for the bundle. Not secret, but never guessable. */
  readonly bundleId: string;
}

export function mintLinkSecrets(crypto: SessionCrypto): LinkSecrets {
  return {
    key: toBase64Url(crypto.randomBytes(LINK_SECRET_BYTES)),
    bundleId: toBase64Url(crypto.randomBytes(LINK_BUNDLE_ID_BYTES)),
  };
}

type LinkEnvelopeRefusal =
  | 'link_too_big'
  | 'malformed_secret'
  | 'malformed_envelope'
  | 'authentication_failed'
  | 'bundle_invalid'
  | 'not_canonical';

export type LinkEnvelopeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: LinkEnvelopeRefusal; readonly reason: string };

const refuse = (refusal: LinkEnvelopeRefusal, reason: string) => ({ ok: false as const, refusal, reason });

const TOO_BIG = 'This is too large to share as a link. Export it as a file instead.';

function decodeSecrets(key: string, bundleId: string): { key: Uint8Array; bundleId: Uint8Array } | null {
  const keyBytes = fromBase64UrlFixed(key, LINK_SECRET_BYTES);
  const idBytes = fromBase64UrlFixed(bundleId, LINK_BUNDLE_ID_BYTES);
  return keyBytes === null || idBytes === null ? null : { key: keyBytes, bundleId: idBytes };
}

/** The token a fetch presents. `null` when the key or the bundle id is not the size it must be. */
export async function linkFetchToken(crypto: SessionCrypto, key: string, bundleId: string): Promise<string | null> {
  const secrets = decodeSecrets(key, bundleId);
  if (secrets === null) return null;
  const token = await crypto.deriveKey(secrets.key, secrets.bundleId, LINK_FETCH_TOKEN_LABEL, LINK_FETCH_TOKEN_BYTES);
  return toBase64Url(token);
}

/** What the store keeps in place of the token: its SHA-256. `null` when the token is not 32 bytes. */
export async function linkFetchVerifier(crypto: SessionCrypto, token: string): Promise<string | null> {
  const bytes = fromBase64UrlFixed(token, LINK_FETCH_TOKEN_BYTES);
  return bytes === null ? null : toBase64Url(await crypto.sha256(bytes));
}

const sequenceBytes = (sequence: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  writeUint32(bytes, 0, sequence);
  return bytes;
};

const associatedData = (bundleId: Uint8Array, sequence: number): Uint8Array =>
  concatBytes([utf8Bytes(LINK_ENVELOPE_AAD_LABEL), new Uint8Array(1), bundleId, sequenceBytes(sequence)]);

const envelopeKey = (crypto: SessionCrypto, secrets: { key: Uint8Array; bundleId: Uint8Array }, sequence: number) =>
  crypto.deriveKey(secrets.key, secrets.bundleId, `${LINK_BUNDLE_KEY_LABEL}/${sequence}`, 32);

const isSequence = (sequence: number): boolean => Number.isInteger(sequence) && sequence >= 1 && sequence <= 0xffffffff;

/**
 * Seal the canonical text of a link bundle: pad, frame, encrypt and check the cap. `bundleCanonicalText`
 * is exactly the text the publisher signed the bundle's document from; it is sealed, never re-spelled.
 */
export async function sealLinkEnvelope(
  crypto: SessionCrypto,
  key: string,
  bundleId: string,
  sequence: number,
  bundleCanonicalText: string,
): Promise<LinkEnvelopeResult<Uint8Array>> {
  const secrets = decodeSecrets(key, bundleId);
  if (secrets === null || !isSequence(sequence))
    return refuse('malformed_secret', 'This link cannot be sealed: its key, id or sequence is malformed.');
  const body = utf8Bytes(bundleCanonicalText);
  const framed = 4 + body.length;
  const padded = Math.ceil(framed / LINK_PADDING_BUCKET_BYTES) * LINK_PADDING_BUCKET_BYTES;
  if (HEADER_BYTES + padded + TAG_BYTES > LINK_ENVELOPE_MAX_BYTES) return refuse('link_too_big', TOO_BIG);
  const plaintext = new Uint8Array(padded);
  writeUint32(plaintext, 0, body.length);
  plaintext.set(body, 4);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const sealed = await crypto.seal(
    await envelopeKey(crypto, secrets, sequence),
    nonce,
    associatedData(secrets.bundleId, sequence),
    plaintext,
  );
  return {
    ok: true,
    value: concatBytes([utf8Bytes(LINK_ENVELOPE_MAGIC), sequenceBytes(sequence), nonce, sealed]),
  };
}

/** The size the sealed envelope of this canonical text will have, or `null` when it is over the cap. */
export function linkEnvelopeSize(bundleCanonicalText: string): number | null {
  const framed = 4 + utf8Bytes(bundleCanonicalText).length;
  const size = HEADER_BYTES + Math.ceil(framed / LINK_PADDING_BUCKET_BYTES) * LINK_PADDING_BUCKET_BYTES + TAG_BYTES;
  return size > LINK_ENVELOPE_MAX_BYTES ? null : size;
}
