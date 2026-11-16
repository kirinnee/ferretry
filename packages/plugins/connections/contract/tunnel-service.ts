/** Tunnel provisioning wire copied from today's relay/tunnel.ts; additive contract approved by kaizen. */
import { z } from 'zod';
import { TunnelOriginSchema } from './wire.ts';
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_SPKI_BYTES = 44;
const NONCE_BYTES = 32;
const DaemonIdSchema = z.string().regex(/^fy_daemon_[A-Za-z0-9_-]{43}$/u, 'invalid daemon id');
function parseDaemonId(value: string): string | null {
  const parsed = DaemonIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Canonical field decoders copied byte-for-byte from the kernel wire; private schema implementation only. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;

/** Encode bytes as unpadded base64url, the only binary spelling this protocol uses in text. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Decode unpadded base64url, refusing anything that is not exactly that.
 *
 * `atob` is lenient in ways a wire format must not be, so the alphabet is checked first and the
 * round trip is checked after: a decoder that silently accepts padding, whitespace or a truncated
 * final group lets two implementations disagree about what a signature covers.
 */
function fromBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL_PATTERN.test(text)) return null;
  if (text.length % 4 === 1) return null;
  // The alphabet and the group length are already proved, so the padded text is always decodable.
  // A `try` here would be a branch nothing can reach, which reads as a guard and is not one.
  const padded = text
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return toBase64Url(bytes) === text ? bytes : null;
}

/** Decode base64url and require an exact length, which every key and signature field has. */
function fromBase64UrlFixed(text: string, length: number): Uint8Array | null {
  const bytes = fromBase64Url(text);
  return bytes !== null && bytes.length === length ? bytes : null;
}

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

/**
 * `POST /v1/tunnel/release` answer. `released` is whether this daemon held a tunnel to release; `false`
 * is an idempotent repeat, never an error. The answer does not wait for Cloudflare: the service takes
 * the tunnel off the daemon at once and deletes it upstream, retrying on its daily alarm until every
 * step has succeeded, so a daemon never retries a release.
 */
export const TunnelReleaseSchema = z.strictObject({
  version: z.literal(TUNNEL_SERVICE_VERSION),
  released: z.boolean(),
});
export type TunnelRelease = z.infer<typeof TunnelReleaseSchema>;

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

export interface SignedTunnelRequest {
  readonly daemonId: string;
  readonly publicKey: string;
  readonly nonce: string;
  readonly signature: string;
}
/** The kernel signs its own identity, under the action-specific tunnel transcript. */
export interface TunnelSignInput {
  readonly action: 'provision' | 'release';
  readonly host: string;
  readonly nonce: string;
  readonly originPort?: number;
}

export const TUNNEL_PATH = '/v1/tunnel';
export const TUNNEL_OFF_SENTENCE = 'Tunnel: off (opt-in) — turn on with fy tunnel on or Settings › Connection';
export const WEBRTC_SESSION_CHANNEL_LABEL = 'fy-session';
export const WEBRTC_GATHER_REFLEXIVE_GRACE_MS = 250;

const PUBLISHED_CSP_INSECURE_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * Exact match is total here because the caller passes `URL.hostname`, which has already lowercased
 * an ASCII name and would have carried brackets only for an address this set does not hold.
 */
function isLoopbackUnderPublishedCsp(hostname: string): boolean {
  return PUBLISHED_CSP_INSECURE_HOSTS.has(hostname);
}

/**
 * A socket address this protocol will dial.
 *
 * Secure schemes anywhere; insecure schemes only against the two hosts the published site's
 * content-security-policy will actually let a browser dial. Accepting a wider loopback here would
 * store a carrier the browser then refuses to open, and refuses BEFORE the request exists, so the
 * person holding the phone gets a dead connection with nothing to read.
 */
export const TunnelServiceEndpointSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'endpoint is not a URL' });
      return z.NEVER;
    }
    const dialableInsecure = isLoopbackUnderPublishedCsp(url.hostname);
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    const insecure = url.protocol === 'http:' || url.protocol === 'ws:';
    if (!secure && !(insecure && dialableInsecure)) {
      context.addIssue({
        code: 'custom',
        message: 'endpoint must be wss/https, or ws/http on localhost or the loopback address',
      });
      return z.NEVER;
    }
    if (url.search !== '' || url.hash !== '') {
      context.addIssue({ code: 'custom', message: 'endpoint carries a query or fragment' });
      return z.NEVER;
    }
    return url.toString().replace(/\/$/u, '');
  });
