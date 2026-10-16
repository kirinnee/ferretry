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

/** The path of the callback page on whatever origin serves the PWA. */
export const MCP_OAUTH_CALLBACK_PATH = '/oauth/mcp-callback';

/**
 * The loopback redirect used when a provider refuses the PWA's address (RFC 8252 §7.3). Nothing
 * listens there: the browser's failed page is how a person copies the address back.
 */
export const MCP_OAUTH_LOOPBACK_REDIRECT = `http://127.0.0.1${MCP_OAUTH_CALLBACK_PATH}`;

/** The longest stem a component name contributes to a secret name. */
const NAME_STEM_LENGTH = 24;

/** FNV-1a, 32 bits: a stable, dependency-free fingerprint of a component's exact name. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(8, '0');
}

/** The secrets and the variable one MCP component's sign-in lives under. */
export interface McpOAuthSecretNames {
  readonly access: SecretName;
  readonly refresh: SecretName;
  readonly client: SecretName;
  /** The launch-environment variable a harness reads the access token from. Not a secret NAME. */
  readonly variable: string;
}

/**
 * The secret names for one component's tokens.
 *
 * Upper-cased, every other character an `_`, cut to {@link NAME_STEM_LENGTH}, and followed by a
 * fingerprint of the EXACT name, so `my-server` and `my_server` — the same stem — never share a token.
 */
export function mcpOAuthSecretNames(component: string): McpOAuthSecretNames {
  const stem = component
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, NAME_STEM_LENGTH)
    .replace(/_+$/u, '');
  const base = `MCP_${stem === '' ? '' : `${stem}_`}${fingerprint(component)}`;
  return {
    access: SecretNameSchema.parse(`${base}_ACCESS`),
    refresh: SecretNameSchema.parse(`${base}_REFRESH`),
    client: SecretNameSchema.parse(`${base}_CLIENT`),
    variable: `FY_${base}_TOKEN`,
  };
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
