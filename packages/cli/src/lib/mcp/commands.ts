import type { Command } from 'commander';

/**
 * `fy mcp serve`: the Ferretry tools as an MCP server on stdin/stdout.
 *
 * Every agent runtime is launched with it already configured (the fleet's fixed layer), so nobody
 * runs this by hand; it is a command so the harness can start it the way it starts any stdio server.
 * It writes nothing but protocol to stdout.
 */
export function registerMcpCommands(program: Command, serve: () => Promise<void>): void {
  const mcp = program.command('mcp').description('the Ferretry tools MCP server agents use');
  mcp
    .command('serve')
    .description('serve the terminal and browser tools over MCP on stdin/stdout, as this agent session')
    .action(async () => {
      await serve();
    });
}
