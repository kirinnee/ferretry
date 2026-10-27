/** The configured MCP components, read from the fleet's account model on every call. */
import type { McpComponent, McpOAuthClient } from '@ferretry/fleet';
import { secretReferencesIn } from '@ferretry/protocol';
import type { McpOAuthServer, McpOAuthServers, McpOAuthStaticClient } from '../../lib/mcp-oauth/ports.ts';

/** Just the part of the account model this needs, so a test hands in a literal. */
export interface McpComponentSource {
  readonly components: { readonly mcp: Readonly<Record<string, McpComponent>> };
}

/** A component's `oauth` block as the sign-in reads it: the secret by NAME, the schema having held it to one reference. */
export function staticClientOf(client: McpOAuthClient): McpOAuthStaticClient {
  const secret = client.clientSecret === undefined ? undefined : secretReferencesIn(client.clientSecret)[0];
  return {
    clientId: client.clientId,
    ...(secret === undefined ? {} : { clientSecret: secret }),
    ...(client.callbackPort === undefined ? {} : { callbackPort: client.callbackPort }),
  };
}

export class AccountModelMcpServers implements McpOAuthServers {
  constructor(private readonly read: () => Promise<McpComponentSource | undefined>) {}

  async list(): Promise<readonly McpOAuthServer[]> {
    const model = await this.read();
    return Object.entries(model?.components.mcp ?? {}).map(([component, server]) => ({
      component,
      ...(server.url === undefined ? {} : { url: server.url }),
      ...(server.auth === undefined ? {} : { auth: server.auth }),
      ...(server.oauth === undefined ? {} : { client: staticClientOf(server.oauth) }),
    }));
  }
}
