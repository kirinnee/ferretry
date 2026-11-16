import { configItemVerbs, implementCli, MCP_ITEM_KEYS, type VerbInvocation } from '@ferretry/kernel/manifest';
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

export default implementCli(manifest, {
  build: ({ client, io, stdin, env, readText, confirm }) => {
    const items = configItemVerbs({
      collection: 'mcp',
      noun: 'MCP server',
      verbPrefix: 'mcp',
      client,
      io,
      readText,
      confirm,
      keys: MCP_ITEM_KEYS,
    });
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
        'mcp add': items.add,
        'mcp show': items.show,
        'mcp edit': items.edit,
        'mcp rm': items.rm,
      },
    };
  },
});
