import type { Command } from 'commander';
import type { McpCheckOptions, McpServersController, McpServersOptions } from './servers.ts';
import type { McpTokenController } from './token.ts';

const SCOPES = 'ferretry, component, user, project or local';

/**
 * `fy mcp …`.
 *
 * `serve` is the Ferretry tools as an MCP server on stdin/stdout. Every agent runtime is launched with it
 * already configured (the fleet's fixed layer), so nobody runs this by hand; it is a command so the
 * harness can start it the way it starts any stdio server. It writes nothing but protocol to stdout.
 *
 * `ls` and `check` are every MCP server a ferret sees, from every scope, and whether one answers
 * (docs/mcp-scopes.md). Inside a ferret they read that ferret; `--machine` reads the whole machine.
 *
 * `token` is Claude Code's `headersHelper` for a signed-in server (docs/mcp-oauth.md): it prints that server's current
 * headers as one JSON object and nothing else, so nobody runs it by hand.
 */
export function registerMcpCommands(
  program: Command,
  serve: () => Promise<void>,
  servers?: McpServersController,
  token?: McpTokenController,
): void {
  const mcp = program.command('mcp').description('MCP: the Ferretry tools server, and every server a ferret sees');
  mcp
    .command('serve')
    .description('serve the terminal and browser tools over MCP on stdin/stdout, as this agent session')
    .action(async () => {
      await serve();
    });
  if (servers === undefined) return;
  mcp
    .command('ls')
    .description('list the MCP servers a ferret sees, by scope, with approval and sign-in')
    .option('--session <id>', 'the ferret to read (default: this one, when run inside one)')
    .option('--machine', 'every server on this machine instead of one ferret')
    .option('--json', 'print the protocol document')
    .action(async (options: McpServersOptions) => {
      await servers.list(options);
    });
  mcp
    .command('check <server>')
    .description('connect to one MCP server and list its tools, by name or id')
    .option('--session <id>', 'check it as this ferret reaches it (default: this one, when run inside one)')
    .option('--machine', 'pick the server from the whole machine instead of one ferret')
    .option('--scope <scope>', `when the name is declared twice: ${SCOPES}`)
    .option('--json', 'print the protocol result')
    .action(async (server: string, options: McpCheckOptions) => {
      await servers.check(server, options);
    });
  if (token === undefined) return;
  mcp
    .command('token <variable>')
    .description("print fresh MCP sign-in headers for this ferret (Claude's headersHelper runs this)")
    .action(async (variable: string) => {
      await token.token(variable);
    });
}
