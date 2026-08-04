/**
 * The trust anchor.
 *
 * A daemon identifier is the SHA-256 fingerprint of its Ed25519 public key, and the pairing QR
 * already carries it out of band in the URL fragment. That is what makes a relay untrusted rather
 * than trusted: a phone that scanned the code knows which key it must see, so a rendezvous cannot
 * introduce it to a different daemon, and cannot claim a rendezvous it does not hold the key for.
 *
 * The fingerprint is computed here exactly as the daemon computes it when it mints its identity —
 * base64url of SHA-256 over the SubjectPublicKeyInfo DER — because a second spelling of the same
 * fingerprint is a second identity, and the two would never meet.
 */

import { DaemonIdSchema } from '@ferretry/protocol';
import { toBase64Url } from './binary.ts';
import { ED25519_SPKI_BYTES } from './constants.ts';
import type { RelayCrypto } from './crypto.ts';

const DAEMON_ID_PREFIX = 'fy_daemon_';

/** Compute the daemon identifier a public key must be known by. */
export async function daemonIdFromPublicKey(crypto: RelayCrypto, publicKeySpki: Uint8Array): Promise<string | null> {
  if (publicKeySpki.length !== ED25519_SPKI_BYTES) return null;
  const digest = await crypto.sha256(publicKeySpki);
  return `${DAEMON_ID_PREFIX}${toBase64Url(digest)}`;
}

/** Parse an identifier a peer supplied. Returns null rather than a value that only looks like one. */
export function parseDaemonId(value: string): string | null {
  const parsed = DaemonIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Does this public key belong to the daemon the caller pinned?
 *
 * The comparison is on the identifier string rather than on raw bytes because that is the form the
 * QR carries and the form a rendezvous reads out of a URL path, and a mismatch between the two
 * forms is exactly the confusion this check exists to prevent.
 */
export async function publicKeyMatchesDaemonId(
  crypto: RelayCrypto,
  publicKeySpki: Uint8Array,
  daemonId: string,
): Promise<boolean> {
  const expected = parseDaemonId(daemonId);
  if (expected === null) return false;
  const actual = await daemonIdFromPublicKey(crypto, publicKeySpki);
  return actual !== null && actual === expected;
}
