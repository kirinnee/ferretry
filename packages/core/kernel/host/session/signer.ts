/**
 * The daemon identity's two outward signatures, offered to carriers as {@link IdentitySigner} on the session layer.
 *
 * Today the relay link signed its rendezvous claim and the tunnel provisioner its requests with the identity key in
 * hand (`signRendezvousClaim`, `signTunnelRequest`). In 5.0 the carriers are a plugin, so the key stays here and a
 * carrier can ask for exactly those two transcripts — built by the kernel, each with its own label — and nothing
 * else. A carrier still checks that the host it was challenged with is the one it dialled
 * (`claimContextForChallenge`); the signer refuses only what is malformed.
 */

import type {
  IdentitySigner,
  RelayClaimRequest,
  SignedRelayClaim,
  SignedTunnelSignature,
  TunnelSignRequest,
} from '../../contract/session.ts';
import { fromBase64UrlFixed, toBase64Url } from './wire/binary.ts';
import { encodeClaim, signRendezvousClaim } from './wire/claim.ts';
import { NONCE_BYTES } from './wire/constants.ts';
import type { DaemonSigningKey } from './wire/crypto.ts';
import { tunnelTranscript } from './wire/tunnel-request.ts';

function nonceBytes(nonce: string): Uint8Array {
  const bytes = typeof nonce === 'string' ? fromBase64UrlFixed(nonce, NONCE_BYTES) : null;
  if (bytes === null) throw new TypeError(`the nonce must be ${NONCE_BYTES} bytes of unpadded base64url`);
  return bytes;
}

function host(value: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError('the host must be named');
  return value;
}

/** The signer over the identity key. The key's private half stays inside `key.sign`. */
export function createIdentitySigner(key: DaemonSigningKey): IdentitySigner {
  return Object.freeze({
    sign: async (request: RelayClaimRequest): Promise<SignedRelayClaim> => {
      const context = { daemonId: key.daemonId, relayHost: host(request.host), challenge: nonceBytes(request.nonce) };
      const claim = encodeClaim(await signRendezvousClaim(key, context));
      return { daemonId: key.daemonId, publicKey: claim.publicKey, signature: claim.signature };
    },
    signTunnel: async (request: TunnelSignRequest): Promise<SignedTunnelSignature> => {
      if (request.action !== 'provision' && request.action !== 'release')
        throw new TypeError('the tunnel action must be provision or release');
      if (
        request.originPort !== undefined &&
        (!Number.isInteger(request.originPort) || request.originPort < 1 || request.originPort > 65_535)
      )
        throw new TypeError('the origin port must be a whole number from 1 to 65535');
      const nonce = nonceBytes(request.nonce);
      const signature = await key.sign(
        tunnelTranscript({
          action: request.action,
          daemonId: key.daemonId,
          host: host(request.host),
          nonce,
          ...(request.originPort === undefined ? {} : { originPort: request.originPort }),
        }),
      );
      return {
        daemonId: key.daemonId,
        publicKey: toBase64Url(key.publicKeySpki),
        nonce: toBase64Url(nonce),
        signature: toBase64Url(signature),
      };
    },
  });
}
