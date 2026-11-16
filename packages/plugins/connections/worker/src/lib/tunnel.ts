/**
 * THE HOSTED TUNNEL CARRIER'S WIRE CONTRACT — `docs/relay-protocol.md` §15.
 *
 * A tunnel is a third carrier kind beside direct and relay: Ferretry's hosted service provisions a
 * Cloudflare Tunnel for one daemon, on one account from an operator-held pool, and hands the daemon
 * ONLY the connector token. The daemon runs `cloudflared` with it, and a browser then opens exactly the
 * session it opens on a direct address (§4) — at `wss://<tunnel host>/v1/rendezvous/<daemonId>/client`.
 * Nothing above the socket changes: same handshake, same fingerprint pin, same records.
 *
 * Everything in this file is pure and shared by both ends of provisioning — the Worker that answers
 * and the daemon that asks — so the two cannot disagree about a shape or a signed byte. The Cloudflare
 * API itself is an adapter concern and is not here; the ingress document is, because what a tunnel
 * forwards is part of the contract (it forwards one route and nothing else).
 */

import { concatBytes, fromBase64UrlFixed, lengthPrefixed, toBase64Url, utf8Bytes } from '../wire/binary.ts';
import { ED25519_SIGNATURE_BYTES, ED25519_SPKI_BYTES } from '../wire/constants.ts';
import type { DaemonIdentity, SessionCrypto } from '../wire/crypto.ts';
import { publicKeyMatchesDaemonId } from '../wire/identity.ts';

export * from '../../../contract/tunnel-service.ts';
import {
  TUNNEL_PROVISION_LABEL,
  TUNNEL_RELEASE_LABEL,
  TUNNEL_PROTOCOL_ID,
  type SignedTunnelRequest,
} from '../../../contract/tunnel-service.ts';

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

/** The daemon half: sign one request with the identity pairing minted. */
export async function signTunnelRequest(
  crypto: SessionCrypto,
  identity: DaemonIdentity,
  context: TunnelRequestContext,
): Promise<SignedTunnelRequest> {
  const signature = await crypto.signEd25519(identity.privateKey, tunnelTranscript(context));
  return {
    daemonId: context.daemonId,
    publicKey: toBase64Url(identity.publicKeySpki),
    nonce: toBase64Url(context.nonce),
    signature: toBase64Url(signature),
  };
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

/** One rule of a remotely managed tunnel's ingress, in Cloudflare's own spelling. */
export interface TunnelIngressRule {
  readonly hostname?: string;
  readonly path?: string;
  readonly service: string;
}

/**
 * WHAT A TUNNEL FORWARDS: one route, to one loopback port, and a 404 for everything else.
 *
 * The path is anchored to this daemon's own direct-session route (§4), so the edge refuses every other
 * path before it reaches the machine — the daemon's tunnel listener refuses them too, so this is the
 * outer of two walls rather than the only one. The service is ALWAYS `http://127.0.0.1:<port>`: the
 * port is the daemon's to say, the host never is, so a provision request cannot point a tunnel at
 * anything but the daemon's own loopback listener.
 */
export function tunnelIngress(hostname: string, daemonId: string, originPort: number): readonly TunnelIngressRule[] {
  return [
    { hostname, path: `^/v1/rendezvous/${daemonId}/client$`, service: `http://127.0.0.1:${originPort}` },
    { service: 'http_status:404' },
  ];
}
