/**
 * PKCE (RFC 7636) and the flow's `state`, from injected randomness.
 *
 * The verifier is 32 random bytes as unpadded base64url — 43 characters, the RFC's minimum length and
 * its recommended construction (§4.1) — and the challenge is `S256` of it (§4.2). `plain` is never
 * offered: a challenge equal to its verifier protects nothing once the authorization URL is seen.
 */

import type { McpOAuthCrypto } from './ports.ts';

/** Unpadded base64url (RFC 4648 §5). */
export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** The RFC 7636 §4.1 verifier alphabet and length. */
export const VERIFIER_SHAPE = /^[A-Za-z0-9\-._~]{43,128}$/u;

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export async function pkcePair(crypto: McpOAuthCrypto): Promise<PkcePair> {
  const verifier = base64Url(crypto.randomBytes(32));
  return { verifier, challenge: base64Url(await crypto.sha256(verifier)) };
}

/** A single-use `state`: 32 random bytes, unguessable and bound to one flow. */
export const flowState = (crypto: McpOAuthCrypto): string => base64Url(crypto.randomBytes(32));

/** A flow id: 16 random bytes. Not a secret — it names a flow to a caller who already may drive it. */
export const flowIdentifier = (crypto: McpOAuthCrypto): string => base64Url(crypto.randomBytes(16));

/**
 * Comparing two strings in time that depends only on their lengths, so a `state` cannot be guessed a
 * character at a time from how long a refusal took.
 */
export function sameText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
