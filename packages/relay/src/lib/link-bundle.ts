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
 * Pure and `RelayCrypto` only, so the daemon, the PWA and the CLI run the same code.
 */
import { catalogCanonicalText, type SharedCatalogLinkBundle, SharedCatalogLinkBundleSchema } from '@ferretry/protocol';
import {
  bytesEqual,
  concatBytes,
  fromBase64UrlFixed,
  isAllZero,
  readUint32,
  toBase64Url,
  utf8Bytes,
  utf8Text,
  writeUint32,
} from './binary.ts';
import type { RelayCrypto } from './crypto.ts';

/** First four bytes of every envelope: the format and its version. */
export const LINK_ENVELOPE_MAGIC = 'FYL1' as const;
/** Domain-separates the envelope's AEAD key from every other key derived from the same secret. */
export const LINK_BUNDLE_KEY_LABEL = 'ferretry-link-bundle-key-v1' as const;
/** Domain-separates the fetch token from the envelope key. */
export const LINK_FETCH_TOKEN_LABEL = 'ferretry-link-fetch-v1' as const;
/** The first bytes of the associated data, ended by a zero byte. */
export const LINK_ENVELOPE_AAD_LABEL = 'ferretry-link-envelope-v1' as const;

/** The plaintext is padded to a multiple of this, so the operator sees a size class rather than a size. */
export const LINK_PADDING_BUCKET_BYTES = 16 * 1024;
/** The largest envelope anything accepts: a 2 MiB skill, JSON escaping, the signed document and padding. */
export const LINK_ENVELOPE_MAX_BYTES = 3 * 1024 * 1024;

export const LINK_SECRET_BYTES = 32;
export const LINK_BUNDLE_ID_BYTES = 16;
export const LINK_FETCH_TOKEN_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = LINK_ENVELOPE_MAGIC.length + 4 + NONCE_BYTES;
/** The least an envelope can be: header, one padding bucket and the tag. */
const MIN_ENVELOPE_BYTES = HEADER_BYTES + LINK_PADDING_BUCKET_BYTES + TAG_BYTES;

/** What a link is made of that only its holders know: the key and the store's name for the bundle. */
export interface LinkSecrets {
  /** 32 random bytes, base64url: lives in the URL fragment only. */
  readonly key: string;
  /** 16 random bytes, base64url: the store's name for the bundle. Not secret, but never guessable. */
  readonly bundleId: string;
}

export function mintLinkSecrets(crypto: RelayCrypto): LinkSecrets {
  return {
    key: toBase64Url(crypto.randomBytes(LINK_SECRET_BYTES)),
    bundleId: toBase64Url(crypto.randomBytes(LINK_BUNDLE_ID_BYTES)),
  };
}

export type LinkEnvelopeRefusal =
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
const NOT_A_LINK = 'This is not a Ferretry link, or it has been damaged.';

function decodeSecrets(key: string, bundleId: string): { key: Uint8Array; bundleId: Uint8Array } | null {
  const keyBytes = fromBase64UrlFixed(key, LINK_SECRET_BYTES);
  const idBytes = fromBase64UrlFixed(bundleId, LINK_BUNDLE_ID_BYTES);
  return keyBytes === null || idBytes === null ? null : { key: keyBytes, bundleId: idBytes };
}

/** The token a fetch presents. `null` when the key or the bundle id is not the size it must be. */
export async function linkFetchToken(crypto: RelayCrypto, key: string, bundleId: string): Promise<string | null> {
  const secrets = decodeSecrets(key, bundleId);
  if (secrets === null) return null;
  const token = await crypto.deriveKey(secrets.key, secrets.bundleId, LINK_FETCH_TOKEN_LABEL, LINK_FETCH_TOKEN_BYTES);
  return toBase64Url(token);
}

/** What the store keeps in place of the token: its SHA-256. `null` when the token is not 32 bytes. */
export async function linkFetchVerifier(crypto: RelayCrypto, token: string): Promise<string | null> {
  const bytes = fromBase64UrlFixed(token, LINK_FETCH_TOKEN_BYTES);
  return bytes === null ? null : toBase64Url(await crypto.sha256(bytes));
}

/** Does this token hash to the verifier the store holds? Compared as bytes, without an early exit. */
export async function linkTokenMatchesVerifier(crypto: RelayCrypto, token: string, verifier: string): Promise<boolean> {
  const expected = fromBase64UrlFixed(verifier, 32);
  const actual = await linkFetchVerifier(crypto, token);
  const actualBytes = actual === null ? null : fromBase64UrlFixed(actual, 32);
  return expected !== null && actualBytes !== null && bytesEqual(expected, actualBytes);
}

const sequenceBytes = (sequence: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  writeUint32(bytes, 0, sequence);
  return bytes;
};

const associatedData = (bundleId: Uint8Array, sequence: number): Uint8Array =>
  concatBytes([utf8Bytes(LINK_ENVELOPE_AAD_LABEL), new Uint8Array(1), bundleId, sequenceBytes(sequence)]);

const envelopeKey = (crypto: RelayCrypto, secrets: { key: Uint8Array; bundleId: Uint8Array }, sequence: number) =>
  crypto.deriveKey(secrets.key, secrets.bundleId, `${LINK_BUNDLE_KEY_LABEL}/${sequence}`, 32);

const isSequence = (sequence: number): boolean => Number.isInteger(sequence) && sequence >= 1 && sequence <= 0xffffffff;

/**
 * Seal the canonical text of a link bundle: pad, frame, encrypt and check the cap. `bundleCanonicalText`
 * is exactly the text the publisher signed the bundle's document from; it is sealed, never re-spelled.
 */
export async function sealLinkEnvelope(
  crypto: RelayCrypto,
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

/** The sequence an envelope declares in the clear, or `null` when it is not an envelope. Authenticated by {@link openLinkEnvelope}. */
export function linkEnvelopeSequence(bytes: Uint8Array): number | null {
  if (bytes.length < MIN_ENVELOPE_BYTES || bytes.length > LINK_ENVELOPE_MAX_BYTES) return null;
  if (!bytesEqual(bytes.subarray(0, LINK_ENVELOPE_MAGIC.length), utf8Bytes(LINK_ENVELOPE_MAGIC))) return null;
  const sequence = readUint32(bytes, LINK_ENVELOPE_MAGIC.length);
  return isSequence(sequence) ? sequence : null;
}

/**
 * Open an envelope: the magic, the bounds, the authentication, the padding, and the bundle's shape.
 * Answers the declared sequence and the bundle. Whether the bundle is TRUE is `verifyLinkBundle`'s question.
 */
export async function openLinkEnvelope(
  crypto: RelayCrypto,
  key: string,
  bundleId: string,
  bytes: Uint8Array,
): Promise<LinkEnvelopeResult<{ readonly sequence: number; readonly bundle: SharedCatalogLinkBundle }>> {
  const secrets = decodeSecrets(key, bundleId);
  if (secrets === null)
    return refuse('malformed_secret', 'This link is damaged: its key or its id is not the size it must be.');
  if (bytes.length > LINK_ENVELOPE_MAX_BYTES) return refuse('link_too_big', TOO_BIG);
  const sequence = linkEnvelopeSequence(bytes);
  if (sequence === null) return refuse('malformed_envelope', NOT_A_LINK);
  const plaintext = await crypto.open(
    await envelopeKey(crypto, secrets, sequence),
    bytes.subarray(LINK_ENVELOPE_MAGIC.length + 4, HEADER_BYTES),
    associatedData(secrets.bundleId, sequence),
    bytes.subarray(HEADER_BYTES),
  );
  if (plaintext === null) return refuse('authentication_failed', NOT_A_LINK);
  if (plaintext.length === 0 || plaintext.length % LINK_PADDING_BUCKET_BYTES !== 0)
    return refuse('malformed_envelope', NOT_A_LINK);
  const length = readUint32(plaintext, 0);
  const end = 4 + length;
  // The padding is exact: the least that reaches a bucket, all zero. Anything else is a second spelling.
  if (length === 0 || end > plaintext.length || plaintext.length - end >= LINK_PADDING_BUCKET_BYTES)
    return refuse('malformed_envelope', NOT_A_LINK);
  if (!isAllZero(plaintext.subarray(end))) return refuse('malformed_envelope', NOT_A_LINK);
  const text = utf8Text(plaintext.subarray(4, end));
  if (text === null) return refuse('bundle_invalid', NOT_A_LINK);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return refuse('bundle_invalid', NOT_A_LINK);
  }
  const parsed = SharedCatalogLinkBundleSchema.safeParse(json);
  if (!parsed.success) return refuse('bundle_invalid', NOT_A_LINK);
  const canonical = catalogCanonicalText(parsed.data);
  if (!canonical.ok || canonical.text !== text) return refuse('not_canonical', NOT_A_LINK);
  return { ok: true, value: { sequence, bundle: parsed.data } };
}
