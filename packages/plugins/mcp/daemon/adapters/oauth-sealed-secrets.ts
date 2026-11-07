import type { StatePort } from '@ferretry/kernel/contract';
import {
  type SealedDocumentsApi,
  type SealedName,
  type SecretName,
  SecretNameSchema,
} from '@ferretry/core-vault/contract';
import { MCP_OAUTH_SECRETS } from '../../contract/index.ts';
import type { McpOAuthInternalSecrets } from '../lib/oauth/service.ts';

/**
 * The sign-in's daemon-internal store — refresh tokens and registered client secrets — over the Vault's sealed-document
 * port: `state/mcp/oauth-secrets.json` (today's `state/mcp-oauth-secrets.json`, byte for byte under the Vault's key).
 *
 * The handle is opened over MCP's OWN state port, so the kernel refuses any document MCP did not declare, and it is
 * handed to nothing but the sign-in service, which opens a value only to send it to the provider that issued it
 * (today's use). Listing answers names; no value ever leaves through a route, a log or an error from here.
 */
export function sealedMcpOAuthSecrets(sealed: SealedDocumentsApi, own: StatePort): McpOAuthInternalSecrets {
  const document = sealed.open(own, MCP_OAUTH_SECRETS);
  const names = async (): Promise<readonly SecretName[]> =>
    (await document.names()).map(name => SecretNameSchema.parse(name));
  return {
    list: async () => (await names()).map(name => ({ name })),
    put: async (name, value) => await document.put(name as SealedName, value),
    remove: async name => await document.delete(name as SealedName),
    values: async () => {
      const opened = new Map<SecretName, string>();
      for (const name of await names()) {
        const value = await document.get(name as SealedName);
        if (value !== undefined) opened.set(name, value);
      }
      return opened;
    },
  };
}
