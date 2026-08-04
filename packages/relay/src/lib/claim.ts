/**
 * How a daemon takes ownership of a rendezvous.
 *
 * A rendezvous is addressed by a daemon fingerprint, and a fingerprint is public — it is printed
 * in a QR code. So the address alone cannot decide who may hold the slot; anyone who saw the code
 * could otherwise sit in it and answer as the daemon. The daemon proves possession of the key
 * behind the fingerprint instead: the rendezvous issues a fresh challenge, the daemon signs it,
 * and the rendezvous accepts only if the presented key both hashes to the fingerprint in the path
 * and verifies the signature.
 *
 * This costs the operator nothing to run. There are no accounts, no registration and no shared
 * secret anywhere in the deployment, which is precisely what makes "deploy your own relay" a
 * single command rather than a provisioning exercise.
 *
 * The signed transcript names the host the daemon believes it is talking to. Without that, a
 * hostile relay could take a live challenge from an honest relay, hand it to the daemon as its
 * own, and use the answer to squat the daemon's slot elsewhere.
 */

import { concatBytes, fromBase64UrlFixed, lengthPrefixed, toBase64Url, utf8Bytes } from './binary.ts';
import {
  CLAIM_SIGNATURE_LABEL,
  ED25519_SIGNATURE_BYTES,
  ED25519_SPKI_BYTES,
  NONCE_BYTES,
  RELAY_PROTOCOL_ID,
} from './constants.ts';
import type { DaemonIdentity, RelayCrypto } from './crypto.ts';
import { publicKeyMatchesDaemonId } from './identity.ts';

/** Everything both sides must agree on before a signature means anything. */
export interface ClaimContext {
  /** The fingerprint in the rendezvous URL path. */
  readonly daemonId: string;
  /** The host the rendezvous is served from, as the daemon's configured relay URL spells it. */
  readonly relayHost: string;
  /** The rendezvous challenge, fresh per socket. */
  readonly challenge: Uint8Array;
}

export interface RendezvousClaim {
  readonly publicKeySpki: Uint8Array;
  readonly signature: Uint8Array;
}

export type ClaimVerdict =
  | { readonly ok: true; readonly publicKeySpki: Uint8Array }
  | { readonly ok: false; readonly reason: string };

/** The exact bytes signed. Reproduced independently by both sides; never transmitted. */
export function claimTranscript(context: ClaimContext): Uint8Array {
  return concatBytes([
    utf8Bytes(CLAIM_SIGNATURE_LABEL),
    lengthPrefixed(utf8Bytes(RELAY_PROTOCOL_ID)),
    lengthPrefixed(utf8Bytes(context.daemonId)),
    lengthPrefixed(utf8Bytes(context.relayHost)),
    lengthPrefixed(context.challenge),
  ]);
}

/**
 * Build the context for a challenge, refusing a host the daemon did not configure.
 *
 * The rendezvous states which host it believes it is, and the daemon signs the host it dialled.
 * They have to be the same string or the binding is decorative, so the check lives here rather
 * than in a caller that could forget it: a signature for somebody else's host is exactly what a
 * hostile relay would like to collect.
 */
export function claimContextForChallenge(
  daemonId: string,
  configuredRelayHost: string,
  challengeHost: string,
  challenge: Uint8Array,
): ClaimContext | null {
  if (configuredRelayHost === '' || challengeHost !== configuredRelayHost) return null;
  return { daemonId, relayHost: configuredRelayHost, challenge };
}

export async function signRendezvousClaim(
  crypto: RelayCrypto,
  identity: DaemonIdentity,
  context: ClaimContext,
): Promise<RendezvousClaim> {
  const signature = await crypto.signEd25519(identity.privateKey, claimTranscript(context));
  return { publicKeySpki: identity.publicKeySpki, signature };
}

/**
 * Decide whether a claim may hold this rendezvous.
 *
 * Both halves are mandatory and neither is sufficient. The fingerprint check says the key is the
 * one the address names; the signature says the claimant holds it right now, for this challenge,
 * and for this host.
 */
export async function verifyRendezvousClaim(
  crypto: RelayCrypto,
  context: ClaimContext,
  claim: RendezvousClaim,
): Promise<ClaimVerdict> {
  if (context.challenge.length !== NONCE_BYTES) return { ok: false, reason: 'challenge is the wrong length' };
  if (claim.publicKeySpki.length !== ED25519_SPKI_BYTES) return { ok: false, reason: 'public key is the wrong length' };
  if (claim.signature.length !== ED25519_SIGNATURE_BYTES) return { ok: false, reason: 'signature is the wrong length' };
  if (!(await publicKeyMatchesDaemonId(crypto, claim.publicKeySpki, context.daemonId))) {
    return { ok: false, reason: 'public key does not match the rendezvous fingerprint' };
  }
  const verified = await crypto.verifyEd25519(claim.publicKeySpki, claim.signature, claimTranscript(context));
  return verified ? { ok: true, publicKeySpki: claim.publicKeySpki } : { ok: false, reason: 'claim signature failed' };
}

/** Wire spelling of a claim: the two fields, base64url, and nothing else. */
export function encodeClaim(claim: RendezvousClaim): { readonly publicKey: string; readonly signature: string } {
  return { publicKey: toBase64Url(claim.publicKeySpki), signature: toBase64Url(claim.signature) };
}

export function decodeClaim(publicKey: string, signature: string): RendezvousClaim | null {
  const publicKeySpki = fromBase64UrlFixed(publicKey, ED25519_SPKI_BYTES);
  const signatureBytes = fromBase64UrlFixed(signature, ED25519_SIGNATURE_BYTES);
  if (publicKeySpki === null || signatureBytes === null) return null;
  return { publicKeySpki, signature: signatureBytes };
}
