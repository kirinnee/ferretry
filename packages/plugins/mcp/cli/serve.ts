import type { PluginClient, TerminalIo } from '@ferretry/kernel/manifest';
import { serveMcpOverStdio } from './adapters/stdio.ts';
import { clientToolsPort } from './lib/serve/port.ts';
import { McpServer } from './lib/serve/server.ts';

/** The server name the runtimes register this server under (the fleet's fixed layer), and the name `initialize` says. */
const SERVER_NAME = 'ferretry';

export interface ServeContext {
  readonly client: PluginClient;
  readonly io: Pick<TerminalIo, 'err' | 'out'>;
  /** Standard input as chunks; absent where a build gives the verb none. */
  readonly stdin: (() => AsyncIterable<Uint8Array>) | undefined;
  /** This plugin's version, which `initialize` reports. */
  readonly version: string;
  /** The one line `initialize` carries; every behavioural instruction is in the appended system prompt. */
  readonly instructions: string;
}

/**
 * `mcp serve`: the agent tools as an MCP server over standard input and output. Its own module, importing neither the
 * manifest nor the servers controller, so the shell can run it without loading the rest of this plugin's CLI half (a
 * ferret keeps one of these for the life of its pane).
 */
export async function serveTools({ client, io, stdin, version, instructions }: ServeContext): Promise<number> {
  if (stdin === undefined) {
    io.err('this build gives `mcp serve` no standard input to read.\n');
    return 70;
  }
  await serveMcpOverStdio(
    new McpServer(clientToolsPort(client), { name: SERVER_NAME, version, instructions }),
    stdin(),
    line => {
      io.out(line);
    },
  );
  return 0;
}
