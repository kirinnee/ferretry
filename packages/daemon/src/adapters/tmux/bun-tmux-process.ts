import { isAbsolute } from 'node:path';
import type { TmuxCommandPort, TmuxCommandResult } from '../../lib/tmux/contracts.ts';

/** Bun-backed tmux process adapter. An absolute private socket is mandatory for fleet safety. */
export class BunTmuxProcess implements TmuxCommandPort {
  constructor(
    private readonly executable: string,
    private readonly socketPath: string,
  ) {
    if (!isAbsolute(executable) || !isAbsolute(socketPath))
      throw new Error('tmux executable and socket path must both be absolute');
  }

  async execute(arguments_: readonly string[], stdin?: string): Promise<TmuxCommandResult> {
    if (arguments_.length === 0 || arguments_[0]?.startsWith('-'))
      throw new Error('tmux command must begin with a command name, not a server option');
    const command = [this.executable, '-S', this.socketPath, ...arguments_];
    if (stdin === undefined)
      return await collect(Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }));
    // A payload is written to the child rather than passed as an argument: argv is world-readable
    // through `/proc`, and a turn brief is longer than the argument limit anyway.
    const child = Bun.spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(stdin);
    await child.stdin.end();
    return await collect(child);
  }
}

/** Both streams are drained alongside the exit so a tmux command that fills a pipe cannot deadlock. */
async function collect(child: {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
}): Promise<TmuxCommandResult> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}
