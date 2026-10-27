/**
 * The wire contract for signing in to a remote MCP server from a browser, with the daemon as the OAuth
 * client (`docs/mcp-oauth.md`).
 *
 * ## What crosses this boundary, and what deliberately never does
 *
 * | value                                | on the wire?  | why                                                         |
 * | ------------------------------------ | ------------- | ----------------------------------------------------------- |
 * | an authorization URL                 | out           | anybody may open it; completing it binds THEIR account      |
 * | the redirect address the PWA chose   | in            | where the provider sends the browser back                   |
 * | the callback address (holds a code)  | **in only**   | checked, redeemed with a verifier only the daemon holds     |
 * | an access, refresh or client secret  | **never**     | the daemon keeps them in its secret store, by name          |
 * | an expiry, an issuer, a scope        | out           | what a person needs to know whether it still works          |
 *
 * There is no field here that could carry a token in either direction. `docs/secrets.md` states that
 * no route returns a secret value; this file is where that is enforced for this feature.
 *
 * ## ONE OWNER FOR THE NAMES
 *
 * The fleet materialiser writes an environment variable and a `${secret:…}` reference for a server,
 * and the daemon stores the tokens under secret names. Those must be the same names, so both call
 * {@link mcpOAuthSecretNames} — there is no second spelling.
 */

import { z } from 'zod';
import { type SecretName, SecretNameSchema } from './secrets.ts';

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The path every callback page lives under on whatever origin serves the PWA. A flow's own redirect is
 * this plus one more segment naming the authorization server ({@link mcpOAuthRedirectPath}).
 */
export const MCP_OAUTH_CALLBACK_PATH = '/oauth/mcp-callback';

/**
 * Where the loopback (paste) redirect points: `http://localhost:<port>/callback`, Claude Code's own shape,
 * because a provider that admits desktop clients admits that one. Nothing listens there; the failed page
 * is the point. Each provider gets its own port, which is what keeps one provider's code from finishing
 * another's sign-in (the per-provider PATH the PWA redirect carries does that job there).
 */
export const MCP_OAUTH_LOOPBACK_HOST = 'localhost';
export const MCP_OAUTH_LOOPBACK_PATH = '/callback';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

/**
 * SHA-256 (FIPS 180-4) as lowercase hex, synchronously, with no dependency. Synchronous because the fleet
 * materialiser that names a secret is pure and synchronous, and it must agree with the daemon to the bit.
 */
export function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const length = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(length);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(length - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(length - 4, (data.length * 8) >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < length; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = w[index - 15] as number;
      const b = w[index - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[index] = ((w[index - 16] as number) + s0 + (w[index - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as unknown as number[];
    for (let index = 0; index < 64; index += 1) {
      const t1 =
        ((h as number) +
          (rotr(e as number, 6) ^ rotr(e as number, 11) ^ rotr(e as number, 25)) +
          (((e as number) & (f as number)) ^ (~(e as number) & (g as number))) +
          (K[index] as number) +
          (w[index] as number)) >>>
        0;
      const t2 =
        ((rotr(a as number, 2) ^ rotr(a as number, 13) ^ rotr(a as number, 22)) +
          (((a as number) & (b as number)) ^ ((a as number) & (c as number)) ^ ((b as number) & (c as number)))) >>>
        0;
      h = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h] as number[];
    for (let index = 0; index < 8; index += 1) hash[index] = ((hash[index] as number) + (next[index] as number)) >>> 0;
  }
  return [...hash].map(word => word.toString(16).padStart(8, '0')).join('');
}

/**
 * A server's canonical address (the MCP spec's "canonical server URI"): no fragment, and no trailing
 * slash on a path that has one. The one spelling a token's binding is computed from.
 */
export function mcpOAuthServerKey(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = '';
  const text = url.toString();
  return url.search === '' && url.pathname !== '/' ? text.replace(/\/+$/u, '') : text;
}

/** The longest stem a component name contributes to a secret name. */
const NAME_STEM_LENGTH = 16;

/** The secrets and the variable one MCP component's sign-in lives under. */
export interface McpOAuthSecretNames {
  readonly access: SecretName;
  /** Held in the daemon-internal store, never the ordinary one: nothing but the sign-in reads it. */
  readonly refresh: SecretName;
  /** The launch-environment variable a harness reads the access token from. Not a secret NAME. */
  readonly variable: string;
}

/**
 * The secret names for one component's tokens AT ONE SERVER.
 *
 * Upper-cased, every other character an `_`, cut to {@link NAME_STEM_LENGTH}, and followed by 64 bits
 * of SHA-256 over the EXACT component name AND the server's canonical address. So `my-server` and
 * `my_server` never share a token, and — the property that matters — **a token is bound to the server
 * it was issued for**: change a component's `url` and the materialiser names a secret the store does not
 * hold, so the launch is refused rather than sending the old server's token to the new one.
 */
export function mcpOAuthSecretNames(component: string, serverUrl: string): McpOAuthSecretNames {
  const stem = component
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, NAME_STEM_LENGTH)
    .replace(/_+$/u, '');
  const binding = sha256Hex(`${component}\n${mcpOAuthServerKey(serverUrl)}`)
    .slice(0, 16)
    .toUpperCase();
  const base = `MCP_${stem === '' ? '' : `${stem}_`}${binding}`;
  return {
    access: SecretNameSchema.parse(`${base}_ACCESS`),
    refresh: SecretNameSchema.parse(`${base}_REFRESH`),
    variable: `FY_${base}_TOKEN`,
  };
}

/**
 * Whether a secret's name is one a sign-in filed itself: an MCP server's OAuth access token.
 *
 * It is the SHAPE {@link mcpOAuthSecretNames} writes (`MCP_<stem>_<16 hex>_ACCESS`), so it answers for
 * every name that function can produce and for no name a person would choose. A secret copy refuses
 * these: the token is half of a sign-in whose refresh half cannot travel, and a copy would be a
 * login that is dead on the other machine within the hour (docs/secrets.md).
 */
export function isSignInSecretName(name: string): boolean {
  return /^MCP_(?:[A-Z0-9_]+_)?[0-9A-F]{16}_ACCESS$/u.test(name);
}

/**
 * One authorization server's own callback path (OAuth Security BCP §4.4.2, the per-AS redirect mix-up
 * defence): a code one provider sends back can only ever arrive at the path of a flow with THAT provider.
 */
export function mcpOAuthRedirectPath(issuer: string): string {
  return `${MCP_OAUTH_CALLBACK_PATH}/${sha256Hex(issuer.replace(/\/+$/u, '')).slice(0, 16)}`;
}

// ── Requests ─────────────────────────────────────────────────────────────────────────────────────

/** Starting a sign-in. `redirectUri` is the PWA's own callback page; absent means "use the paste way". */
export const McpOAuthStartRequestSchema = z.strictObject({
  redirectUri: z.string().min(1).max(512).optional(),
});
export type McpOAuthStartRequest = z.infer<typeof McpOAuthStartRequestSchema>;

/**
 * Finishing one: the address the provider sent the browser to. It carries an authorization code, so it
 * travels only in a POST body and is answered with nothing that repeats it.
 */
export const McpOAuthCompleteRequestSchema = z.strictObject({
  callback: z.string().min(1).max(8192),
});
export type McpOAuthCompleteRequest = z.infer<typeof McpOAuthCompleteRequestSchema>;

// ── Answers ──────────────────────────────────────────────────────────────────────────────────────

/** How the browser comes back: to the PWA's page, or to a loopback page whose address is pasted. */
export const McpOAuthRedirectModeSchema = z.enum(['pwa', 'paste']);
export type McpOAuthRedirectMode = z.infer<typeof McpOAuthRedirectModeSchema>;

/** One sign-in in progress. */
export const McpOAuthFlowSchema = z.strictObject({
  flowId: z.string().min(1).max(128),
  component: z.string().min(1).max(256),
  /** The provider's page to open. Holds the state and the PKCE challenge — never the verifier. */
  authorizeUrl: z.url(),
  mode: McpOAuthRedirectModeSchema,
  /** Where the provider will send the browser back. */
  redirectUri: z.url(),
  /** The authorization server's host, so a person can see who they are signing in with. */
  issuer: z.string().min(1).max(512),
  expiresAt: z.iso.datetime({ offset: true }),
  /** Why the flow is not in the mode the browser asked for, when it is not. */
  note: z.string().max(512).optional(),
});
export type McpOAuthFlow = z.infer<typeof McpOAuthFlowSchema>;

/** Where one component's sign-in stands. */
export const McpOAuthStateSchema = z.enum(['signed-in', 'expired', 'needs-sign-in']);
export type McpOAuthState = z.infer<typeof McpOAuthStateSchema>;

export const McpOAuthConnectionSchema = z.strictObject({
  component: z.string().min(1).max(256),
  state: McpOAuthStateSchema,
  /** The authorization server it is signed in with. */
  issuer: z.string().min(1).max(512).optional(),
  signedInAt: z.iso.datetime({ offset: true }).optional(),
  /** When the access token stops working. Absent when the provider did not say. */
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  /** Whether the daemon can renew it on its own at the next launch. */
  renewable: z.boolean(),
  scope: z.string().max(2048).optional(),
  /** The secret names it is stored under, so a person can find them in Settings → Secrets. */
  secrets: z.array(SecretNameSchema).readonly(),
});
export type McpOAuthConnection = z.infer<typeof McpOAuthConnectionSchema>;

export const McpOAuthConnectionListSchema = z.strictObject({
  connections: z.array(McpOAuthConnectionSchema).readonly(),
});
export type McpOAuthConnectionList = z.infer<typeof McpOAuthConnectionListSchema>;

/** What finishing a sign-in answers: the connection, and the component name the audit log keeps. */
export const McpOAuthCompletionSchema = z.strictObject({
  component: z.string().min(1).max(256),
  connection: McpOAuthConnectionSchema,
});
export type McpOAuthCompletion = z.infer<typeof McpOAuthCompletionSchema>;

/** What signing out answers. */
export const McpOAuthSignedOutSchema = z.strictObject({
  component: z.string().min(1).max(256),
  removed: z.boolean(),
  /** Whether the provider confirmed revoking the refresh token. `false` is not a failure. */
  revoked: z.boolean(),
});
export type McpOAuthSignedOut = z.infer<typeof McpOAuthSignedOutSchema>;

/** What cancelling a sign-in answers. `cancelled: false` means there was no such flow to end. */
export const McpOAuthFlowCancelledSchema = z.strictObject({
  flowId: z.string().min(1).max(128),
  cancelled: z.boolean(),
});
export type McpOAuthFlowCancelled = z.infer<typeof McpOAuthFlowCancelledSchema>;

/** The routes, spelled once for both ends. */
export const MCP_OAUTH_PATH = '/v1/fleet/mcp-auth';
