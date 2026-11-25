import { shellQuote } from './shell-quote.ts';

/** The `fy` sub-command Claude's `headersHelper` runs: `fy mcp token <VARIABLE>` (docs/mcp-oauth.md). */
const MCP_TOKEN_SUBCOMMAND = 'mcp token';

/**
 * The shell command Claude Code runs as a signed-in MCP server's `headersHelper`: it prints the server's CURRENT
 * `Authorization` header, so a ferret that outlives its access token (Slack's lives twelve hours) keeps working
 * instead of sending the token it was launched with. `binary` is the one `fy` the wrappers already use; `variable`
 * is the launch variable the server's static header names (`mcpOAuthSecretNames().variable`).
 *
 * The caller binds it once (`fyCommand`), so a component's entry and a project server's entry spell it the same.
 */
export function claudeMcpTokenCommand(binary: string, variable: string): string {
  return `${shellQuote(binary)} ${MCP_TOKEN_SUBCOMMAND} ${variable}`;
}

/** {@link claudeMcpTokenCommand} with the binary bound: the shape both writers of a Claude server entry take. */
export type ClaudeMcpTokenCommand = (variable: string) => string;
