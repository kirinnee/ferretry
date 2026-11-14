import { ConfigItems, implementCli, itemVerb, type VerbInvocation } from '@ferretry/kernel/manifest';
import { TOOLS_SERVER_INSTRUCTIONS } from '@ferretry/plugin-runtimes/contract';
import manifest from '../manifest.ts';
import { mcpItemKind } from './lib/items.ts';
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

/** The binary's name every hint names (`CliContext` does not carry it; single-sourced in `packages/cli/package.json`). */
const BINARY_NAME = 'fy';

export default implementCli(manifest, {
  build: ({ client, io, stdin, env, confirm }) => {
    const servers = new McpServersController(clientServersGateway(client), io, env?.FY_SESSION_ID);
    const items = new ConfigItems(
      { client, io, binary: BINARY_NAME, ...(confirm === undefined ? {} : { confirm }) },
      mcpItemKind,
    );
    const item = (body: () => Promise<number>): Promise<number> => itemVerb({ io }, body);
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
        'mcp add': async invocation => await item(() => items.add(invocation)),
        'mcp show': async invocation =>
          await item(() => items.show(invocation.args[0], { json: on(invocation, 'json') })),
        'mcp edit': async invocation => await item(() => items.edit(invocation)),
        'mcp rm': async invocation => await item(() => items.remove(invocation)),
      },
    };
  },
});
