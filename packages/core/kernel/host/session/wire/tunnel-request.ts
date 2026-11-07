/**
 * The signed bytes of a hosted-tunnel request (`docs/relay-protocol.md` §15), copied from today's
 * `packages/relay/src/lib/tunnel.ts` byte for byte. Only the transcript and its check live here: the daemon signs
 * through the kernel's identity signer, and the hosted service verifies with the same function, so the two cannot
 * disagree about a signed byte. The provisioning wire shapes, the account pool and the ingress are Connections'.
 */

import { concatBytes, fromBase64UrlFixed, lengthPrefixed, toBase64Url, utf8Bytes } from './binary.ts';
import { ED25519_SIGNATURE_BYTES, ED25519_SPKI_BYTES } from './constants.ts';
import type { SessionCrypto } from './crypto.ts';
import { publicKeyMatchesDaemonId } from './identity.ts';

/** The provisioning protocol identifier, signed into every request. */
export const TUNNEL_PROTOCOL_ID = 'ferretry-tunnel/1' as const;

/** Signature labels, one per action, so a signed provision can never be replayed as a release. */
export const TUNNEL_PROVISION_LABEL = 'ferretry-tunnel-provision-v1' as const;
export const TUNNEL_RELEASE_LABEL = 'ferretry-tunnel-release-v1' as const;

export type TunnelAction = 'provision' | 'release';

export interface TunnelRequestContext {
  readonly action: TunnelAction;
  readonly daemonId: string;
  /** The hosted service's host, as the daemon's discovered origin spells it. */
  readonly host: string;
  readonly nonce: Uint8Array;
  /** Present for a provision, absent for a release; signed either way so the two cannot collide. */
  readonly originPort?: number;
}

/**
 * The signed message:
 *
 *   label ‖ LP("ferretry-tunnel/1") ‖ LP(daemonId) ‖ LP(host) ‖ LP(nonce) ‖ LP(originPort as decimal, or "")
 *
 * `host` is in it for the reason it is in a rendezvous claim (§5): a hostile service cannot take a live
 * challenge from an honest one and spend the answer elsewhere, and a daemon refuses to sign a host it
 * did not discover. `originPort` is in it so nobody between the two can redirect the ingress.
 */
export function tunnelTranscript(context: TunnelRequestContext): Uint8Array {
  return concatBytes([
    utf8Bytes(context.action === 'provision' ? TUNNEL_PROVISION_LABEL : TUNNEL_RELEASE_LABEL),
    lengthPrefixed(utf8Bytes(TUNNEL_PROTOCOL_ID)),
    lengthPrefixed(utf8Bytes(context.daemonId)),
    lengthPrefixed(utf8Bytes(context.host)),
    lengthPrefixed(context.nonce),
    lengthPrefixed(utf8Bytes(context.originPort === undefined ? '' : String(context.originPort))),
  ]);
}

/** A signed request as it travels: the four fields, base64url where binary. */
export interface SignedTunnelRequest {
  readonly daemonId: string;
  readonly publicKey: string;
  readonly nonce: string;
  readonly signature: string;
}

export type TunnelRequestVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The service half. Accepts only if the key hashes to the fingerprint AND the signature verifies over
 * the transcript the SERVICE rebuilds from its own host and its own outstanding nonce — the request's
 * copy of the nonce is compared, never trusted to rebuild the message.
 */
export async function verifyTunnelRequest(
  crypto: SessionCrypto,
  context: TunnelRequestContext,
  request: SignedTunnelRequest,
): Promise<TunnelRequestVerdict> {
  const publicKey = fromBase64UrlFixed(request.publicKey, ED25519_SPKI_BYTES);
  const signature = fromBase64UrlFixed(request.signature, ED25519_SIGNATURE_BYTES);
  if (publicKey === null || signature === null) return { ok: false, reason: 'key or signature is malformed' };
  if (request.daemonId !== context.daemonId) return { ok: false, reason: 'fingerprint does not match the challenge' };
  if (request.nonce !== toBase64Url(context.nonce)) return { ok: false, reason: 'nonce does not match the challenge' };
  if (!(await publicKeyMatchesDaemonId(crypto, publicKey, context.daemonId)))
    return { ok: false, reason: 'public key does not match the fingerprint' };
  const verified = await crypto.verifyEd25519(publicKey, signature, tunnelTranscript(context));
  return verified ? { ok: true } : { ok: false, reason: 'signature failed' };
}
