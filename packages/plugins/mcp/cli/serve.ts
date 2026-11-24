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
  /**
   * Whether the daemon answers its liveness route. The channel pump asks it after a first 401 (a booting daemon has not
   * loaded its tokens) and stops only on a second 401 from a daemon that said it was healthy. Absent: healthy.
   */
  readonly healthy?: (() => Promise<boolean>) | undefined;
  /**
   * Whether the launch gave Claude the channel flag: `FERRETRY_CHANNEL` is set ONLY in the `--mcp-config` of a launch whose
   * argv carries `--dangerously-load-development-channels`. The channel pump runs only then; without it the server is a
   * plain tools server and never polls, so the daemon never takes it for a listening channel.
   */
  readonly channel?: boolean | undefined;
  /** This process's subscriber id, fresh per process (the daemon fences older subscribers' claims with it). */
  readonly generation?: string | undefined;
  /**
   * Whether a package is on, read from the daemon's plugin inventory (the one owner of on/off). Absent where a build
   * cannot read it: every tool is then listed.
   */
  readonly isOn?: ((plugin: string) => Promise<boolean>) | undefined;
}

/** `input` until it ends or `ended` settles, whichever is first. Never waits on the source after `ended`. */
async function* endedBy(input: AsyncIterable<Uint8Array>, ended: Promise<'revoked'>): AsyncGenerator<Uint8Array> {
  const iterator = input[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), ended]);
      if (next === 'revoked' || next.done === true) return;
      yield next.value;
    }
  } finally {
    // Not awaited: a source blocked on a read (standard input) would hold the exit open.
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

/**
 * `mcp serve`: the agent tools as an MCP server over standard input and output. Its own module, importing neither the
 * manifest nor the servers controller, so the shell can run it without loading the rest of this plugin's CLI half (a
 * ferret keeps one of these for the life of its pane).
 *
 * It is also Ferretry's CHANNEL into a Claude Code session ({@link ChannelPump}): once the client says it is initialized,
 * messages the daemon holds for this session are written to the same output as `notifications/claude/channel`.
 */
export async function serveTools({
  client,
  io,
  stdin,
  version,
  instructions,
  sleep,
  healthy,
  channel,
  generation,
  isOn,
}: ServeContext): Promise<number> {
  if (stdin === undefined) {
    io.err('this build gives `mcp serve` no standard input to read.\n');
    return 70;
  }
  const write = (line: string): void => {
    io.out(line);
  };
  const pump =
    sleep === undefined || channel !== true
      ? undefined
      : new ChannelPump(clientChannelPort(client), write, {
          generation: generation ?? crypto.randomUUID(),
          sleep,
          ...(healthy === undefined ? {} : { healthy }),
          onError: message => {
            io.err(`${message}\n`);
          },
        });
  // Set when the daemon refuses this ferret's credential: the input is then cut off so the server ends, and fails.
  let ended: (() => void) | undefined;
  const revoked = new Promise<'revoked'>(resolve => {
    ended = () => {
      resolve('revoked');
    };
  });
  let credentialRevoked = false;
  await serveMcpOverStdio(
    new McpServer(
      isOn === undefined ? clientToolsPort(client) : { ...clientToolsPort(client), isOn },
      {
        name: SERVER_NAME,
        version,
        instructions,
        channel: channel === true,
        ...(sleep === undefined ? {} : { sleep }),
      },
      () => {
        // Never awaited: it ends when stopped, and a poll still waiting at the daemon must not hold the process open.
        void pump
          ?.start()
          .then(outcome => {
            if (outcome !== 'credential_revoked') return;
            credentialRevoked = true;
            ended?.();
          })
          .catch(() => undefined);
      },
    ),
    endedBy(stdin(), revoked),
    write,
  );
  pump?.stop();
  // A server whose credential is gone exits non-zero, so Claude shows it as failed instead of a zombie that answers nothing.
  return credentialRevoked ? 1 : 0;
}
