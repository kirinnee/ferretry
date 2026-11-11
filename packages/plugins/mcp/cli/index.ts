import { implementCli, type VerbHandler, type VerbInvocation } from '@ferretry/kernel/manifest';
import { TOOLS_SERVER_INSTRUCTIONS } from '@ferretry/plugin-runtimes/contract';
import manifest from '../manifest.ts';
import { serveTools } from './serve.ts';
import { clientServersGateway, McpServersController } from './lib/servers.ts';

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
        'mcp serve': async () =>
          await serveTools({
            client,
            io,
            stdin,
            version: manifest.version,
            instructions: TOOLS_SERVER_INSTRUCTIONS,
          }),
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
