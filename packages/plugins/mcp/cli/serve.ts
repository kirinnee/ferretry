import type { PluginClient, TerminalIo } from '@ferretry/kernel/manifest';
import { serveMcpOverStdio } from './adapters/stdio.ts';
import { ChannelPump } from './lib/serve/channel.ts';
import { clientChannelPort, clientToolsPort } from './lib/serve/port.ts';
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
  /**
   * The shell's wait, in milliseconds. The channel pump backs off with it; a shell that gives none has no channel (the
   * tools still work, and the daemon, seeing no poll, types messages instead).
   */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * `mcp serve`: the agent tools as an MCP server over standard input and output. Its own module, importing neither the
 * manifest nor the servers controller, so the shell can run it without loading the rest of this plugin's CLI half (a
 * ferret keeps one of these for the life of its pane).
 *
 * It is also Ferretry's CHANNEL into a Claude Code session ({@link ChannelPump}): once the client says it is initialized,
 * messages the daemon holds for this session are written to the same output as `notifications/claude/channel`.
 */
export async function serveTools({ client, io, stdin, version, instructions, sleep }: ServeContext): Promise<number> {
  if (stdin === undefined) {
    io.err('this build gives `mcp serve` no standard input to read.\n');
    return 70;
  }
  const write = (line: string): void => {
    io.out(line);
  };
  const pump =
    sleep === undefined
      ? undefined
      : new ChannelPump(clientChannelPort(client), write, {
          sleep,
          onError: message => {
            io.err(`${message}\n`);
          },
        });
  await serveMcpOverStdio(
    new McpServer(clientToolsPort(client), { name: SERVER_NAME, version, instructions }, () => {
      // Never awaited: it ends when stopped, and a poll still waiting at the daemon must not hold the process open.
      pump?.start().catch(() => undefined);
    }),
    stdin(),
    write,
  );
  pump?.stop();
  return 0;
}
