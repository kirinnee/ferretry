/**
 * THE DEVICE'S HALF OF A MUTUAL HANDSHAKE.
 *
 * §6 proves the DAEMON to the device: the device pins a fingerprint and checks a signature over the
 * transcript. This module is the other direction. A paired device holds a non-extractable Ed25519 key
 * and, once the channel is keyed, signs the SAME transcript hash — the arrangement TLS 1.3 uses for a
 * client certificate (`CertificateVerify`). The daemon keeps only the public half, so there is no
 * bearer value anywhere: nothing stored that can be copied, nothing on the wire that can be replayed.
 *
 * WHY THE TRANSCRIPT HASH. It covers both ephemeral keys, both nonces, the daemon's identity and the
 * session id, so a proof is valid for exactly one session. A relay that records it has recorded
 * something no other session will accept — and it never sees it at all, because the proof travels in
 * the sealed sequence-1 record.
 *
 * ONE LABEL PER ACT. Opening a session, registering a key at pairing, renewing a lease and replacing a
 * key each sign a different domain-separated message, so a proof made for one can never be presented as another.
 */

import { z } from 'zod';
import { concatBytes, fromBase64UrlFixed, lengthPrefixed, toBase64Url, utf8Bytes } from './binary.ts';
import {
  APP_SESSION_BYTES,
  DEVICE_AUTH_LABEL,
  DEVICE_PAIR_LABEL,
  DEVICE_RENEW_LABEL,
  DEVICE_ROTATE_LABEL,
  ED25519_SIGNATURE_BYTES,
  ED25519_SPKI_BYTES,
  NONCE_BYTES,
} from './constants.ts';
import type { PrivateKeyHandle, RelayCrypto } from './crypto.ts';

/** The fixed DER prefix of an Ed25519 SubjectPublicKeyInfo; the remaining 32 bytes are the key. */
const ED25519_SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00] as const;

const base64UrlOf = (byteLength: number): z.ZodString =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u, 'not base64url')
    .length(Math.ceil((byteLength * 4) / 3), 'wrong encoded length');

/**
 * A device public key as it crosses the wire: an Ed25519 SPKI, base64url.
 *
 * The prefix is checked here rather than left to `importKey`, because a stored key that is not an
 * Ed25519 SPKI would sit in the daemon's state as a device that can never authenticate — silently.
 */
export const DeviceKeySchema = base64UrlOf(ED25519_SPKI_BYTES).refine(
  text => deviceKeyBytes(text) !== null,
  'not an Ed25519 public key',
);

/** One Ed25519 signature, base64url. */
export const DeviceProofSchema = base64UrlOf(ED25519_SIGNATURE_BYTES);

/** The page-lifetime name a step-up belongs to: 16 random bytes, base64url. */
export const AppSessionSchema = base64UrlOf(APP_SESSION_BYTES);

/** The single-use challenge a daemon sends when a lease is about to end. */
export const RenewNonceSchema = base64UrlOf(NONCE_BYTES);

/** The SPKI bytes of a device key, or `null` when the text is not one. */
export function deviceKeyBytes(text: string): Uint8Array | null {
  const bytes = fromBase64UrlFixed(text, ED25519_SPKI_BYTES);
  if (bytes === null) return null;
  return ED25519_SPKI_PREFIX.every((byte, index) => bytes[index] === byte) ? bytes : null;
}

/** Which kind of credential record a session-opening proof was made for. */
export type DeviceAuthKind = 'auth' | 'stream';

const labelled = (label: string, transcriptHash: Uint8Array, fields: readonly string[]): Uint8Array =>
  concatBytes([
    utf8Bytes(label),
    new Uint8Array([0]),
    transcriptHash,
    ...fields.map(field => lengthPrefixed(utf8Bytes(field))),
  ]);

/** `"ferretry-device-auth-v2" ‖ 0x00 ‖ TH ‖ LP(t) ‖ LP(deviceId) ‖ LP(appSession)` */
export function deviceAuthMessage(
  transcriptHash: Uint8Array,
  kind: DeviceAuthKind,
  deviceId: string,
  appSession: string,
): Uint8Array {
  return labelled(DEVICE_AUTH_LABEL, transcriptHash, [kind, deviceId, appSession]);
}

/** `"ferretry-device-pair-v2" ‖ 0x00 ‖ TH ‖ LP(deviceKey as its base64url text)` */
export function devicePairMessage(transcriptHash: Uint8Array, deviceKey: string): Uint8Array {
  return labelled(DEVICE_PAIR_LABEL, transcriptHash, [deviceKey]);
}

/** `"ferretry-device-renew-v2" ‖ 0x00 ‖ TH ‖ LP(nonce as its base64url text)` */
export function deviceRenewMessage(transcriptHash: Uint8Array, nonce: string): Uint8Array {
  return labelled(DEVICE_RENEW_LABEL, transcriptHash, [nonce]);
}

/**
 * `"ferretry-device-rotate-v2" ‖ 0x00 ‖ TH ‖ LP(deviceId) ‖ LP(deviceKey as its base64url text)`
 *
 * Signed by the NEW key, inside a session the OLD key opened (`docs/design/zero-trust.md` B6): the old
 * key vouches for the session, the session for the transcript, and this proves the new key's holder is
 * the one on the other end of it — so a replacement can never be presented in another session or for
 * another device.
 */
export function deviceRotateMessage(transcriptHash: Uint8Array, deviceId: string, deviceKey: string): Uint8Array {
  return labelled(DEVICE_ROTATE_LABEL, transcriptHash, [deviceId, deviceKey]);
}

/** Signs one of the messages above with the device key; the signature is returned as base64url. */
export async function signDeviceProof(
  crypto: RelayCrypto,
  deviceKey: PrivateKeyHandle,
  message: Uint8Array,
): Promise<string> {
  return toBase64Url(await crypto.signEd25519(deviceKey, message));
}

/**
 * Whether `proof` is the device key's signature over `message`. Total: anything malformed is `false`.
 *
 * A signature check has no secret to protect by running in constant time — the public key and the
 * message are both known to the verifier — so the only discipline here is never throwing.
 */
export async function verifyDeviceProof(
  crypto: RelayCrypto,
  deviceKey: string,
  proof: string,
  message: Uint8Array,
): Promise<boolean> {
  const spki = deviceKeyBytes(deviceKey);
  const signature = fromBase64UrlFixed(proof, ED25519_SIGNATURE_BYTES);
  if (spki === null || signature === null) return false;
  return await crypto.verifyEd25519(spki, signature, message);
}
