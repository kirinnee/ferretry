/** The configured MCP components, read from the fleet's account model on every call. */
import type { McpComponent } from '@ferretry/fleet';
import type { McpOAuthServer, McpOAuthServers } from '../../lib/mcp-oauth/ports.ts';

/** Just the part of the account model this needs, so a test hands in a literal. */
export interface McpComponentSource {
  readonly components: { readonly mcp: Readonly<Record<string, McpComponent>> };
}

export class AccountModelMcpServers implements McpOAuthServers {
  constructor(private readonly read: () => Promise<McpComponentSource | undefined>) {}

  async list(): Promise<readonly McpOAuthServer[]> {
    const model = await this.read();
    return Object.entries(model?.components.mcp ?? {}).map(([component, server]) => ({
      component,
      ...(server.url === undefined ? {} : { url: server.url }),
      ...(server.auth === undefined ? {} : { auth: server.auth }),
    }));
  }
}
