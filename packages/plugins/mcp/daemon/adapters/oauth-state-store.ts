import type { StatePort } from '@ferretry/kernel/contract';
import { MCP_OAUTH_STATE } from '../../contract/index.ts';
import type { McpOAuthStateDocument, McpOAuthStateStore } from '../lib/oauth/ports.ts';
import { EMPTY_MCP_OAUTH_STATE } from '../lib/oauth/service.ts';

/**
 * `state/mcp/oauth.json` through the kernel's state port (atomic, `0600`, format-checked): what is known about each
 * MCP sign-in that is NOT secret. The tokens are in the Vault; this file never holds one.
 *
 * DAMAGED IS NOT EMPTY. A document that will not read raises, rather than reading as "never signed in" and quietly
 * orphaning the tokens the Vault still holds. Only a state home that never signed in answers the empty document.
 */
export class StateMcpOAuthStateStore implements McpOAuthStateStore {
  constructor(private readonly state: StatePort) {}

  async read(): Promise<McpOAuthStateDocument> {
    const read = await this.state.read(MCP_OAUTH_STATE);
    if (!read.ok) throw new Error('oauth.json is not a document this daemon can read');
    return read.value ?? EMPTY_MCP_OAUTH_STATE;
  }

  async write(document: McpOAuthStateDocument): Promise<void> {
    await this.state.write(MCP_OAUTH_STATE, document);
  }
}
