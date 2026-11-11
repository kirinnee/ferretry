import { implementCli, type VerbHandler, type VerbInvocation } from '@ferretry/kernel/manifest';
import { TOOLS_SERVER_INSTRUCTIONS } from '@ferretry/plugin-runtimes/contract';
import manifest from '../manifest.ts';
import { serveMcpOverStdio } from './adapters/stdio.ts';
import { clientToolsPort } from './lib/serve/port.ts';
import { McpServer } from './lib/serve/server.ts';
import { clientServersGateway, McpServersController } from './lib/servers.ts';

/** The server name the runtimes register this server under (the fleet's fixed layer), and the name `initialize` says. */
const SERVER_NAME = 'ferretry';

const on = (invocation: VerbInvocation, name: string): boolean => {
  const value = invocation.options[name];
  return value === true || value === 'true';
};

const text = (invocation: VerbInvocation, name: string): string | undefined => {
  const value = invocation.options[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? (value[value.length - 1] as string | undefined) : undefined;
};

/**
 * The item verbs edit MCP server items, and the item service that serves them has no route in this build. Said plainly
 * rather than pretended (the claude-code `itemVerb` pattern).
 */
const itemVerb =
  (io: { err(text: string): void }): VerbHandler =>
  async () => {
    io.err(
      'MCP server items are edited through the item service, which is not served by this daemon yet; nothing was changed.\n',
    );
    return 69;
  };

export default implementCli(manifest, {
  build: ({ client, io, stdin, env }) => {
    const servers = new McpServersController(clientServersGateway(client), io, env?.FY_SESSION_ID);
    return {
      verbs: {
        'mcp serve': async () => {
          if (stdin === undefined) {
            io.err('this build gives `mcp serve` no standard input to read.\n');
            return 70;
          }
          await serveMcpOverStdio(
            new McpServer(clientToolsPort(client), {
              name: SERVER_NAME,
              version: manifest.version,
              // One line only. Every behavioural instruction is in the appended system prompt the runtime wrapper
              // composes, which a harness weighs above a server's instructions.
              instructions: TOOLS_SERVER_INSTRUCTIONS,
            }),
            stdin(),
            line => {
              io.out(line);
            },
          );
          return 0;
        },
        'mcp ls': async invocation =>
          await servers.list({
            ...(text(invocation, 'session') === undefined ? {} : { session: text(invocation, 'session') as string }),
            machine: on(invocation, 'machine'),
            json: on(invocation, 'json'),
          }),
        'mcp check': async invocation => {
          const target = invocation.args[0];
          if (target === undefined) {
            io.err('name the server to check: `fy mcp check <server>`\n');
            return 2;
          }
          return await servers.check(target, {
            ...(text(invocation, 'session') === undefined ? {} : { session: text(invocation, 'session') as string }),
            ...(text(invocation, 'scope') === undefined ? {} : { scope: text(invocation, 'scope') as string }),
            machine: on(invocation, 'machine'),
            json: on(invocation, 'json'),
          });
        },
        'mcp add': itemVerb(io),
        'mcp show': itemVerb(io),
        'mcp edit': itemVerb(io),
        'mcp rm': itemVerb(io),
      },
    };
  },
});
