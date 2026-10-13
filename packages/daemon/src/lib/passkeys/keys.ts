/**
 * The two encodings a WebAuthn verifier must translate between: the COSE public key an
 * authenticator hands over at registration, which becomes a SubjectPublicKeyInfo (SPKI) DER the
 * daemon stores and WebCrypto imports; and the DER-encoded ECDSA signature an ES256 authenticator
 * produces, which becomes the raw `r ‖ s` form WebCrypto verifies.
 *
 * Both are written here rather than imported (`docs/design/zero-trust.md` B2): the shapes are fixed
 * and small, and every dependency on the verification path is attack surface.
 */

import { concatBytes } from '@ferretry/relay';
import { type CborValue, isCborMap } from './cbor.ts';

/** The COSE algorithms a passkey may use: ES256, EdDSA (Ed25519) and RS256. */
export type PasskeyAlgorithm = -7 | -8 | -257;

export const ES256: PasskeyAlgorithm = -7;
export const EDDSA: PasskeyAlgorithm = -8;
export const RS256: PasskeyAlgorithm = -257;

/** True when `value` is one of the three accepted COSE algorithms. */
export function isPasskeyAlgorithm(value: unknown): value is PasskeyAlgorithm {
  return value === ES256 || value === EDDSA || value === RS256;
}

/** A COSE key translated for storage, or why it could not be. */
export type CoseKeyResult =
  | { readonly ok: true; readonly algorithm: PasskeyAlgorithm; readonly spki: Uint8Array }
  | { readonly ok: false; readonly reason: 'malformed' | 'unsupported-algorithm' };

// COSE key labels (RFC 9052 §7, RFC 9053 §7).
const KTY = 1;
const ALG = 3;
const CRV_OR_N = -1;
const X_OR_E = -2;
const Y = -3;

const KTY_OKP = 1;
const KTY_EC2 = 2;
const KTY_RSA = 3;
const CRV_P256 = 1;
const CRV_ED25519 = 6;

const P256_COORDINATE = 32;
const ED25519_KEY = 32;
/** Below 2048 bits an RSA key is refused; above 4096 it is refused as implausible. */
const RSA_MIN_MODULUS = 256;
const RSA_MAX_MODULUS = 512;
const RSA_MAX_EXPONENT = 8;

/** SPKI DER up to the BIT STRING contents for an uncompressed P-256 point (id-ecPublicKey, prime256v1). */
const P256_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
  0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
]);
/** SPKI DER up to the BIT STRING contents for an Ed25519 key (id-Ed25519). */
const ED25519_SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
/** The AlgorithmIdentifier for rsaEncryption with its NULL parameters. */
const RSA_ALGORITHM_IDENTIFIER = Uint8Array.from([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

/** Translate a decoded COSE_Key into SPKI DER, refusing any key whose algorithm and type disagree. */
export function coseKeyToSpki(key: CborValue): CoseKeyResult {
  if (!isCborMap(key)) return { ok: false, reason: 'malformed' };
  const algorithm = key.get(ALG);
  const type = key.get(KTY);
  if (!isPasskeyAlgorithm(algorithm)) return { ok: false, reason: 'unsupported-algorithm' };
  if (algorithm === ES256) {
    if (type !== KTY_EC2 || key.get(CRV_OR_N) !== CRV_P256) return { ok: false, reason: 'unsupported-algorithm' };
    const x = fixedBytes(key.get(X_OR_E), P256_COORDINATE);
    const y = fixedBytes(key.get(Y), P256_COORDINATE);
    if (x === undefined || y === undefined) return { ok: false, reason: 'malformed' };
    return { ok: true, algorithm, spki: concatBytes([P256_SPKI_PREFIX, x, y]) };
  }
  if (algorithm === EDDSA) {
    if (type !== KTY_OKP || key.get(CRV_OR_N) !== CRV_ED25519) return { ok: false, reason: 'unsupported-algorithm' };
    const x = fixedBytes(key.get(X_OR_E), ED25519_KEY);
    if (x === undefined) return { ok: false, reason: 'malformed' };
    return { ok: true, algorithm, spki: concatBytes([ED25519_SPKI_PREFIX, x]) };
  }
  if (type !== KTY_RSA) return { ok: false, reason: 'unsupported-algorithm' };
  const modulus = unsignedInteger(key.get(CRV_OR_N), RSA_MAX_MODULUS);
  const exponent = unsignedInteger(key.get(X_OR_E), RSA_MAX_EXPONENT);
  if (modulus === undefined || exponent === undefined || modulus.length < RSA_MIN_MODULUS) {
    return { ok: false, reason: 'malformed' };
  }
  const rsaPublicKey = derNode(0x30, concatBytes([derInteger(modulus), derInteger(exponent)]));
  const bitString = derNode(0x03, concatBytes([Uint8Array.of(0), rsaPublicKey]));
  return { ok: true, algorithm, spki: derNode(0x30, concatBytes([RSA_ALGORITHM_IDENTIFIER, bitString])) };
}

/**
 * Convert an ES256 signature from DER `SEQUENCE { INTEGER r, INTEGER s }` to raw `r ‖ s`, each a
 * 32-byte big-endian value: a DER integer drops leading zeros (so may be shorter) and gains a zero
 * byte when its top bit is set (so may be 33 bytes). Anything else is `undefined`.
 */
export function derSignatureToRaw(der: Uint8Array): Uint8Array | undefined {
  // The longest P-256 signature is 72 bytes, so only DER's short length form can be valid here.
  if (der[0] !== 0x30 || der[1] !== der.length - 2 || der.length > 2 + 2 * (2 + P256_COORDINATE + 1)) {
    return undefined;
  }
  const r = derIntegerAt(der, 2);
  if (r === undefined) return undefined;
  const s = derIntegerAt(der, r.end);
  if (s === undefined || s.end !== der.length) return undefined;
  return concatBytes([r.value, s.value]);
}

function derIntegerAt(
  der: Uint8Array,
  offset: number,
): { readonly value: Uint8Array; readonly end: number } | undefined {
  const length = der[offset + 1];
  if (der[offset] !== 0x02 || length === undefined || length === 0 || length > P256_COORDINATE + 1) return undefined;
  const end = offset + 2 + length;
  if (end > der.length) return undefined;
  const content = der.subarray(offset + 2, end);
  // A set top bit is a negative integer, which neither half of a signature can be.
  if (((content[0] ?? 0) & 0x80) !== 0) return undefined;
  let start = 0;
  while (start < content.length && content[start] === 0) start += 1;
  const magnitude = content.subarray(start);
  if (magnitude.length > P256_COORDINATE) return undefined;
  const value = new Uint8Array(P256_COORDINATE);
  value.set(magnitude, P256_COORDINATE - magnitude.length);
  return { value, end };
}

function fixedBytes(value: CborValue | undefined, length: number): Uint8Array | undefined {
  return value instanceof Uint8Array && value.length === length ? value : undefined;
}

/** A COSE big-endian unsigned integer, with its leading zeros dropped; empty or zero is refused. */
function unsignedInteger(value: CborValue | undefined, maximum: number): Uint8Array | undefined {
  if (!(value instanceof Uint8Array)) return undefined;
  let start = 0;
  while (start < value.length && value[start] === 0) start += 1;
  const magnitude = value.subarray(start);
  return magnitude.length === 0 || magnitude.length > maximum ? undefined : magnitude;
}

function derInteger(magnitude: Uint8Array): Uint8Array {
  const content = ((magnitude[0] ?? 0) & 0x80) === 0 ? magnitude : concatBytes([Uint8Array.of(0), magnitude]);
  return derNode(0x02, content);
}

function derNode(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.of(tag), derLength(content.length), content]);
}

/**
 * A DER length. Only two forms occur: the exponent is under 128 bytes, and every node holding the
 * modulus is at least 256 bytes (the RSA floor) and under 64 KiB (the ceiling), so the one-byte long
 * form (0x81) can never be the minimal encoding of anything this module emits.
 */
function derLength(length: number): Uint8Array {
  return length < 0x80 ? Uint8Array.of(length) : Uint8Array.of(0x82, length >> 8, length & 0xff);
}
