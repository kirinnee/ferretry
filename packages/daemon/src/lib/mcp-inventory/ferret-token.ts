/**
 * Handing a RUNNING ferret the current token behind one of its own MCP sign-in variables
 * (`POST /v1/sessions/:sessionId/mcp/token`, docs/mcp-oauth.md › A ferret that outlives its token).
 *
 * WHY. A signed-in MCP server reaches a Claude ferret as an `Authorization: Bearer ${VARIABLE}` header whose
 * variable was resolved ONCE, at launch. An access token lives hours (Slack's: twelve), a ferret can live weeks, and
 * `/mcp` reconnects with the same stale variable — so every call failed from the first expiry on. Claude Code runs a
 * server's `headersHelper` at connect time and again after a 401; the helper is `fy mcp token <VARIABLE>`, and this
 * is what it asks.
 *
 * THE BOUNDARY. This is the documented GAP of a sign-in extended in time and no further: a ferret can already read
 * the token in its own environment, and this hands it that very token, renewed. It never names a secret (only a
 * variable of the sign-in shape, `McpTokenRequestSchema`), it answers only the session the credential belongs to
 * (the mount refuses every other caller), and it computes "what would THIS session be launched with right now" from
 * the session's own agent and folder — so a ferret cannot ask for a server its launch did not hold.
 *
 * It writes nothing — no `.claude.json` reconcile — and an error never carries provider text or the token.
 */
import type { McpTokenAnswer } from '@ferretry/protocol';
import type { FerretMcpToken } from './project-sign-in.ts';
import { McpInventoryRefusal } from './service.ts';

/** What the service reads of one session: the runtime it runs as and the folder it started in. */
export interface FerretTokenSession {
  readonly config: { readonly agent: string; readonly cwd: string };
}

export interface FerretMcpTokensDeps {
  readonly sessions: { get(sessionId: string): Promise<FerretTokenSession | undefined> };
  /** `FleetLaunchEnvironment.mcpTokenFor`. */
  readonly tokens: { mcpTokenFor(wrapper: string, cwd: string, variable: string): Promise<FerretMcpToken> };
}

export class FerretMcpTokens {
  constructor(private readonly deps: FerretMcpTokensDeps) {}

  /** The headers Claude's `headersHelper` prints, or a refusal in plain words. */
  async headers(sessionId: string, variable: string): Promise<McpTokenAnswer> {
    const session = await this.deps.sessions.get(sessionId);
    if (session === undefined) throw new McpInventoryRefusal(404, 'not-found', `no session ${sessionId}`);
    const answer = await this.deps.tokens.mcpTokenFor(session.config.agent, session.config.cwd, variable);
    switch (answer.kind) {
      case 'token':
        return { variable, headers: { Authorization: `Bearer ${answer.token}` } };
      case 'needs-sign-in':
        throw new McpInventoryRefusal(
          409,
          'mcp_needs_sign_in',
          `The sign-in to “${answer.server}” can no longer be renewed, so there is no working token for this ferret. Ask the owner to sign in to that server again in Ferretry (fy mcp ls shows which servers need it).`,
        );
      case 'unknown':
        throw new McpInventoryRefusal(
          404,
          'not_this_ferrets_server',
          `${variable} is not a sign-in variable this ferret was launched with, so there is no token to give it.`,
        );
    }
  }
}
