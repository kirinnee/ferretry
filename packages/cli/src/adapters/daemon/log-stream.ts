import type { IDaemonLogPort } from '../../lib/daemon/ports.ts';

/**
 * How a log-streaming child is started; injectable so the follow path is testable without a hang.
 *
 * The argv is a non-empty tuple, so there is no "no command" case to guard — and therefore no
 * unreachable line a coverage gate would push someone into faking a test for.
 */
export type LogStreamSpawner = (argv: readonly [string, ...string[]]) => { readonly exited: Promise<number> };

const inheritStdio: LogStreamSpawner = ([command, ...args]) =>
  Bun.spawn([command, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });

/**
 * Streams the daemon log to this terminal.
 *
 * `tail -F` rather than `-f`: it follows by NAME and retries, so it survives the log being rotated or
 * truncated and works when the file does not exist yet. kteam used `-f`, which silently keeps reading
 * a rotated-away inode — an operator watching a live daemon sees nothing more and cannot tell why.
 *
 * The one-shot read is a `cat` wired to this terminal rather than a whole-file read into memory:
 * kteam's `readFile` had to hold the entire log, which is fine until the log is hundreds of megabytes.
 */
export class TailDaemonLog implements IDaemonLogPort {
  constructor(private readonly spawn: LogStreamSpawner = inheritStdio) {}

  async exists(logFile: string): Promise<boolean> {
    return await Bun.file(logFile).exists();
  }

  async show(logFile: string, follow: boolean): Promise<number> {
    return await this.spawn(follow ? ['tail', '-F', '-n', '+1', logFile] : ['cat', logFile]).exited;
  }
}
