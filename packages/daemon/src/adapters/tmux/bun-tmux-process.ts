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

  async execute(arguments_: readonly string[]): Promise<TmuxCommandResult> {
    if (arguments_.length === 0 || arguments_[0]?.startsWith('-'))
      throw new Error('tmux command must begin with a command name, not a server option');
    const child = Bun.spawn([this.executable, '-S', this.socketPath, ...arguments_], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  }
}
