/* byte-copied; replace with kernel export when approved. Mirrors packages/core/kernel/host/session/wire/constants.ts (the session wire the kernel owns); the link-store Worker cannot import the kernel host, and the kernel pure wire subpath is not exported yet. Keep byte-identical below this line. */
/**
 * Every constant the wire format pins, in one place, because a reimplementation in another
 * language has to agree with all of them exactly.
 *
 * Domain-separation labels are spelled out in full rather than composed from a prefix: a label is
 * a cryptographic input, and a template that quietly changes when a version bumps produces two
 * peers that derive different keys and blame the network.
 */

/** Length of every challenge, hello and handshake nonce. */
export const NONCE_BYTES = 32 as const;

export const SHARED_SECRET_BYTES = 32 as const;
export const AEAD_TAG_BYTES = 16 as const;

/** Ed25519 material: a 44-byte SPKI encoding of the public key and a 64-byte signature. */
export const ED25519_SPKI_BYTES = 44 as const;
export const ED25519_SIGNATURE_BYTES = 64 as const;
