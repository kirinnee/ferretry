import { isAbsolute } from 'node:path';
import type { SpawnPort } from '@ferretry/kernel/contract';
import type { TmuxCommandPort, TmuxCommandResult } from '../../lib/tmux/contracts.ts';
import { carriesPayload, scriptArguments, scriptLine } from '../../lib/tmux/script.ts';

/** The program the manifest declares in `permissions.spawn`; the kernel's spawn port runs nothing else. */
export const TMUX_PROGRAM = 'tmux';

/**
 * The tmux process adapter, through the kernel's spawn port (today's `BunTmuxProcess`). An absolute private socket
 * is mandatory for fleet safety.
 */
export class KernelTmuxProcess implements TmuxCommandPort {
  constructor(
    private readonly spawn: SpawnPort,
    private readonly socketPath: string,
    private readonly executable: string = TMUX_PROGRAM,
  ) {
    if (!isAbsolute(socketPath)) throw new Error('the tmux socket path must be absolute');
  }

  async execute(arguments_: readonly string[], stdin?: string): Promise<TmuxCommandResult> {
    if (arguments_.length === 0 || arguments_[0]?.startsWith('-'))
      throw new Error('tmux command must begin with a command name, not a server option');
    // A pane's environment and the keys typed into it are payloads, not addresses: they go to tmux as a
    // script on stdin so no process listing on the host ever shows them (`lib/tmux/script.ts`).
    if (carriesPayload(arguments_)) {
      // Stdin is already the script's, so a payload that ALSO brings its own stdin has nowhere safe to go.
      if (stdin !== undefined)
        throw new Error(`tmux ${arguments_[0] ?? ''} carries a payload and cannot also take stdin`);
      return await this.execute(scriptArguments(arguments_), scriptLine(arguments_));
    }
    // `-u` makes tmux print UTF-8 whatever this process's locale says. Without it a daemon started
    // with no UTF-8 locale — which is every daemon a service manager or `fy daemon start` launches
    // unless told otherwise — gets every tab and non-ASCII byte in a format's output back as `_`, so
    // a tab-separated answer arrives as one field and every session launch failed on it.
    const command = ['-u', '-S', this.socketPath, ...arguments_];
    // A payload is written to the child rather than passed as an argument: argv is world-readable
    // through `/proc`, and a turn brief is longer than the argument limit anyway. Both streams are drained
    // alongside the exit by the spawn port, so a tmux command that fills a pipe cannot deadlock.
    const result = await this.spawn.run(this.executable, command, stdin === undefined ? undefined : { stdin });
    return { code: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
  }
}
