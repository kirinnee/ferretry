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
  CatalogSignRequest,
  IdentitySigner,
  SecretOfferSignRequest,
  SignedSecretOffer,
  RelayClaimRequest,
  SignedCatalogSignature,
  SignedRelayClaim,
  SignedTunnelSignature,
  TunnelSignRequest,
} from '../../contract/session.ts';
import { fromBase64UrlFixed, toBase64Url } from './wire/binary.ts';
import { catalogSignedBytes, isCatalogSignatureKind } from './wire/catalog-signature.ts';
import { encodeClaim, signRendezvousClaim } from './wire/claim.ts';
import { NONCE_BYTES } from './wire/constants.ts';
import type { DaemonSigningKey } from './wire/crypto.ts';
import { secretOfferSignedBytes } from './wire/secret-offer.ts';
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

const webCryptoSha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));

/**
 * The signer over the identity key. The key's private half stays inside `key.sign`; every signature it makes has a
 * fixed, kernel-owned label, and there is no `sign(bytes)`.
 */
export function createIdentitySigner(
  key: DaemonSigningKey,
  sha256: (bytes: Uint8Array) => Promise<Uint8Array> = webCryptoSha256,
): IdentitySigner {
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
    signCatalog: async (request: CatalogSignRequest): Promise<SignedCatalogSignature> => {
      if (!isCatalogSignatureKind(request.kind)) throw new TypeError('the catalog signature kind must be manifest, versions or link');
      if (!(request.canonical instanceof Uint8Array)) throw new TypeError('the canonical document must be bytes');
      const signature = await key.sign(catalogSignedBytes(request.kind, await sha256(request.canonical)));
      return { daemonId: key.daemonId, publicKey: toBase64Url(key.publicKeySpki), signature: toBase64Url(signature) };
    },
    signSecretOffer: async (request: SecretOfferSignRequest): Promise<SignedSecretOffer> => {
      for (const field of [request.importId, request.publicKey, request.expiresAt])
        if (typeof field !== 'string' || field === '') throw new TypeError('every offer field must be named');
      if (!Number.isInteger(request.v)) throw new TypeError('the offer version must be a whole number');
      const identityKey = toBase64Url(key.publicKeySpki);
      const fields = {
        v: request.v,
        importId: request.importId,
        daemonId: key.daemonId,
        identityKey,
        publicKey: request.publicKey,
        expiresAt: request.expiresAt,
      };
      const signature = await key.sign(secretOfferSignedBytes(fields));
      return { daemonId: key.daemonId, identityKey, signature: toBase64Url(signature) };
    },
  });
}

/**
 * Which plugins may ask for which signature through `kernel.signer` (a security path, like a hook's takers): the
 * carriers' claim and tunnel signatures are Connections', catalog signatures are Catalogs'. Any other caller is
 * refused before the key is touched.
 */
export const SIGNER_USERS = Object.freeze({
  sign: ['connections'],
  signTunnel: ['connections'],
  signCatalog: ['catalogs'],
  signSecretOffer: ['vault'],
} as const satisfies Record<keyof IdentitySigner, readonly string[]>);

/** The signer as one plugin receives it: each method refuses (`TypeError`) unless {@link SIGNER_USERS} names it. */
export function signerFor(plugin: string, signer: IdentitySigner): IdentitySigner {
  const allowed = (method: keyof IdentitySigner): void => {
    if (!(SIGNER_USERS[method] as readonly string[]).includes(plugin))
      throw new TypeError(`${plugin} may not ask the daemon identity for that signature.`);
  };
  return Object.freeze<IdentitySigner>({
    sign: async request => (allowed('sign'), await signer.sign(request)),
    signTunnel: async request => (allowed('signTunnel'), await signer.signTunnel(request)),
    signCatalog: async request => (allowed('signCatalog'), await signer.signCatalog(request)),
    signSecretOffer: async request => (allowed('signSecretOffer'), await signer.signSecretOffer(request)),
  });
}
