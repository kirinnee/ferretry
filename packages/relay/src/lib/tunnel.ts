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

import { TunnelOriginSchema } from '@ferretry/protocol';
import { z } from 'zod';
import { concatBytes, fromBase64UrlFixed, lengthPrefixed, toBase64Url, utf8Bytes } from './binary.ts';
import { ED25519_SIGNATURE_BYTES, ED25519_SPKI_BYTES, NONCE_BYTES } from './constants.ts';
import type { DaemonIdentity, RelayCrypto } from './crypto.ts';
import { parseDaemonId, publicKeyMatchesDaemonId } from './identity.ts';

/** The provisioning protocol identifier, signed into every request. */
export const TUNNEL_PROTOCOL_ID = 'ferretry-tunnel/1' as const;
/** The advertisement's document version. */
export const TUNNEL_SERVICE_VERSION = 1 as const;

/** Public, no-store: whether this hosted service can provision tunnels at all. */
export const TUNNEL_SERVICE_PATH = '/v1/tunnel-service' as const;
/** Mints a single-use nonce a provision or release must sign. */
export const TUNNEL_CHALLENGE_PATH = '/v1/tunnel/challenge' as const;
/** Creates or renews this daemon's tunnel and answers its connector token. */
export const TUNNEL_PROVISION_PATH = '/v1/tunnel/provision' as const;
/** Deletes this daemon's tunnel: the daemon's operator switched the carrier off. */
export const TUNNEL_RELEASE_PATH = '/v1/tunnel/release' as const;
/** Operator-only, behind the same bearer as `/v1/operator/*`: the pool's census, never a credential. */
export const TUNNEL_OPERATOR_STATUS_PATH = '/v1/operator/tunnels' as const;

/** Signature labels, one per action, so a signed provision can never be replayed as a release. */
export const TUNNEL_PROVISION_LABEL = 'ferretry-tunnel-provision-v1' as const;
export const TUNNEL_RELEASE_LABEL = 'ferretry-tunnel-release-v1' as const;

/** How long a challenge nonce may be signed and spent. It is single-use within that window. */
export const TUNNEL_CHALLENGE_SECONDS = 60;
/** How often a running daemon renews: each renewal stamps the tunnel as used. */
export const DEFAULT_TUNNEL_RENEW_SECONDS = 24 * 60 * 60;
/** A tunnel no daemon renewed for this long is deleted, DNS record included. Operator-configurable. */
export const DEFAULT_TUNNEL_RECLAIM_DAYS = 30;
/**
 * Cloudflare's default ceiling on `cloudflared` tunnels per account ("Tunnels per account: 1,000",
 * Cloudflare One account limits, October 2026; raisable only on Enterprise). An account's configured
 * `maxTunnels` may be lower, never higher.
 */
export const CLOUDFLARE_TUNNELS_PER_ACCOUNT = 1000;
/** Accounts one pool may hold. A bound so a malformed secret cannot become an unbounded scan. */
export const MAX_TUNNEL_ACCOUNTS = 64;

const base64UrlOfLength = (bytes: number) =>
  z.string().refine(value => fromBase64UrlFixed(value, bytes) !== null, `must be ${bytes} bytes of base64url`);

const DaemonIdField = z.string().refine(value => parseDaemonId(value) !== null, 'not a daemon fingerprint');

/** `GET /v1/tunnel-service`. `available: false` is "the operator has not set this up", never an error. */
export const TunnelServiceAdvertisementSchema = z.strictObject({
  version: z.literal(TUNNEL_SERVICE_VERSION),
  available: z.boolean(),
});
export type TunnelServiceAdvertisement = z.infer<typeof TunnelServiceAdvertisementSchema>;

/** `POST /v1/tunnel/challenge` body. */
export const TunnelChallengeRequestSchema = z.strictObject({ daemonId: DaemonIdField });
export type TunnelChallengeRequest = z.infer<typeof TunnelChallengeRequestSchema>;

/** `POST /v1/tunnel/challenge` answer. */
export const TunnelChallengeSchema = z.strictObject({
  version: z.literal(TUNNEL_SERVICE_VERSION),
  nonce: base64UrlOfLength(NONCE_BYTES),
  deadlineSeconds: z.number().int().min(1).max(TUNNEL_CHALLENGE_SECONDS),
});
export type TunnelChallenge = z.infer<typeof TunnelChallengeSchema>;

/** The loopback port `cloudflared` forwards to on the daemon's host — a number, never a host. */
export const TunnelOriginPortSchema = z.number().int().min(1).max(65_535);

const SignedFields = {
  daemonId: DaemonIdField,
  publicKey: base64UrlOfLength(ED25519_SPKI_BYTES),
  nonce: base64UrlOfLength(NONCE_BYTES),
  signature: base64UrlOfLength(ED25519_SIGNATURE_BYTES),
};

/** `POST /v1/tunnel/provision` body. */
export const TunnelProvisionRequestSchema = z.strictObject({ ...SignedFields, originPort: TunnelOriginPortSchema });
export type TunnelProvisionRequest = z.infer<typeof TunnelProvisionRequestSchema>;

/** `POST /v1/tunnel/release` body. */
export const TunnelReleaseRequestSchema = z.strictObject(SignedFields);
export type TunnelReleaseRequest = z.infer<typeof TunnelReleaseRequestSchema>;

/**
 * `POST /v1/tunnel/provision` answer.
 *
 * `connectorToken` IS A CREDENTIAL: whoever holds it can run a connector for this tunnel. It is the
 * ONLY Cloudflare credential that ever leaves the hosted service — never the account's API token — and
 * the daemon keeps it in memory and hands it to `cloudflared` through the child's environment, never in
 * an argument vector, a log line or a file. What a stolen one buys is bounded in §15: traffic to the
 * hostname, which is ciphertext under a handshake only the daemon's identity key can complete.
 */
export const TunnelProvisionSchema = z.strictObject({
  version: z.literal(TUNNEL_SERVICE_VERSION),
  tunnelUrl: TunnelOriginSchema,
  connectorToken: z.string().min(1).max(4096),
  renewAfterSeconds: z
    .number()
    .int()
    .min(60)
    .max(7 * DEFAULT_TUNNEL_RENEW_SECONDS),
});
export type TunnelProvision = z.infer<typeof TunnelProvisionSchema>;

export const TunnelRefusalCodeSchema = z.enum([
  'tunnel_unavailable',
  'tunnel_capacity',
  'tunnel_claim_rejected',
  'tunnel_challenge_expired',
  'tunnel_rate_limited',
  'tunnel_upstream_failed',
  'tunnel_bad_request',
]);
export type TunnelRefusalCode = z.infer<typeof TunnelRefusalCodeSchema>;

/** Every refusal on these routes: a machine code a daemon can act on, and a sentence it can print. */
export const TunnelRefusalSchema = z.strictObject({
  error: z.strictObject({ code: TunnelRefusalCodeSchema, message: z.string().min(1).max(512) }),
});
export type TunnelRefusal = z.infer<typeof TunnelRefusalSchema>;

/**
 * ONE ACCOUNT IN THE OPERATOR'S POOL — Worker configuration, never the repository.
 *
 * The pool is the Worker secret `TUNNEL_ACCOUNTS`: a JSON array of these. A tunnel's public hostname
 * must be on a zone in the SAME Cloudflare account as the tunnel ("The cfargotunnel.com subdomain only
 * proxies traffic for DNS records in the same Cloudflare account"), which is why every account carries
 * its own zone. The API token needs Account › Cloudflare Tunnel: Edit, plus Zone › DNS: Edit and Zone › Zone: Read on that zone.
 *
 * `accepting: false` DRAINS an account: no new tunnel lands on it, while the ones it holds keep being
 * renewed and reclaimed — removing an account outright would leave its tunnels with nobody holding the
 * token that can delete them.
 */
export const TunnelAccountSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/u, 'a short lowercase name'),
  accountId: z.string().regex(/^[0-9a-f]{32}$/u, 'a 32-hex Cloudflare account id'),
  apiToken: z.string().min(1).max(512),
  zoneId: z.string().regex(/^[0-9a-f]{32}$/u, 'a 32-hex Cloudflare zone id'),
  /** The zone's apex. Tunnel hostnames are ONE label under it, which Universal SSL's wildcard covers. */
  zone: z
    .string()
    .max(200)
    .regex(/^(?=.{1,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u, 'a lowercase DNS zone'),
  maxTunnels: z.number().int().min(1).max(CLOUDFLARE_TUNNELS_PER_ACCOUNT).default(CLOUDFLARE_TUNNELS_PER_ACCOUNT),
  accepting: z.boolean().default(true),
});
export type TunnelAccount = z.infer<typeof TunnelAccountSchema>;

export const TunnelAccountPoolSchema = z
  .array(TunnelAccountSchema)
  .max(MAX_TUNNEL_ACCOUNTS)
  .refine(accounts => new Set(accounts.map(account => account.name)).size === accounts.length, 'names must be unique')
  .refine(
    accounts => new Set(accounts.map(account => account.accountId)).size === accounts.length,
    'an account may appear once',
  );
export type TunnelAccountPool = z.infer<typeof TunnelAccountPoolSchema>;

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

export interface SignedTunnelRequest {
  readonly daemonId: string;
  readonly publicKey: string;
  readonly nonce: string;
  readonly signature: string;
}

/** The daemon half: sign one request with the identity pairing minted. */
export async function signTunnelRequest(
  crypto: RelayCrypto,
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
  crypto: RelayCrypto,
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
