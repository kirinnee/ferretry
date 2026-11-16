/** The configured MCP items, read from `config/mcp/*.yaml` on every call (the files are the source of truth). */
import { secretReferencesIn } from '@ferretry/core-vault/contract';
import type { McpItem } from '../../contract/index.ts';
import type { McpOAuthServer, McpOAuthServers, McpOAuthStaticClient } from '../lib/oauth/ports.ts';

/** An item's `oauth` block as the sign-in reads it: the secret by NAME, the schema having held it to one reference. */
function staticClientOf(client: NonNullable<McpItem['oauth']>): McpOAuthStaticClient {
  const secret = client.clientSecret === undefined ? undefined : secretReferencesIn(client.clientSecret)[0];
  return {
    clientId: client.clientId,
    ...(secret === undefined ? {} : { clientSecret: secret }),
    ...(client.callbackPort === undefined ? {} : { callbackPort: client.callbackPort }),
  };
}

export class ConfigMcpServers implements McpOAuthServers {
  constructor(private readonly items: () => ReadonlyMap<string, McpItem>) {}

  async list(): Promise<readonly McpOAuthServer[]> {
    return [...this.items()].map(([component, server]) => ({
      component,
      ...(server.url === undefined ? {} : { url: server.url }),
      ...(server.auth === undefined ? {} : { auth: server.auth }),
      ...(server.oauth === undefined ? {} : { client: staticClientOf(server.oauth) }),
    }));
  }
}
