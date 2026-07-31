import type { IDaemonLogPort } from '../../lib/daemon/ports.ts';

/**
 * Streams the daemon log to this terminal.
 *
 * `tail -F` rather than `-f`: it follows by NAME and retries, so it survives the log being rotated or
 * truncated and works when the file does not exist yet. kteam used `-f`, which silently keeps reading
 * a rotated-away inode — an operator watching a live daemon sees nothing more and cannot tell why.
 */
export class TailDaemonLog implements IDaemonLogPort {
  async exists(logFile: string): Promise<boolean> {
    return await Bun.file(logFile).exists();
  }

  async show(logFile: string, follow: boolean): Promise<number> {
    const child = Bun.spawn(follow ? ['tail', '-F', '-n', '+1', logFile] : ['cat', logFile], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return await child.exited;
  }
}
