/**
 * v4 MCP files (4.291.5). A LOCAL copy on purpose: the product has no v4 reader.
 *
 * - `state/mcp-oauth.json` (`packages/daemon/src/adapters/mcp-oauth/file-state-store.ts`, `FileMcpOAuthStateStore`):
 *   `{v: 1, registrations: {<component>: [...]}, connections: {<component>: {...}}}`, strict, `0600`. What is known
 *   about each MCP sign-in that is NOT secret: issuer, endpoints, client id, expiry. `clientSecretRef` NAMES a secret.
 *   A damaged file raises in v4 ("damaged is not empty"), never reads as "never signed in".
 * - `state/mcp-oauth-secrets.json` (`bin/modules/mcp.ts:152`, `FileSecretDocumentStore`): the sealed daemon-internal
 *   store of refresh tokens and registered client secrets, under the vault's key. SECRET: never opened here.
 * - The ACCESS tokens are ordinary vault secrets in `state/secrets.json`, kept by name: the Vault step moves them.
 * - No inventory file and no payload folder: v4 computes the MCP inventory live (`lib/mcp-inventory`).
 */
import { z } from 'zod';

export const V4_MCP_OAUTH = 'state/mcp-oauth.json';
export const V4_MCP_OAUTH_SECRETS = 'state/mcp-oauth-secrets.json';

/** The envelope only; the records are checked by v5's `McpOAuthStateFileSchema` (v4's own record schemas, verbatim). */
export const V4McpOAuthDocument = z.strictObject({
  v: z.literal(1),
  registrations: z.record(z.string(), z.unknown()),
  connections: z.record(z.string(), z.unknown()),
});
