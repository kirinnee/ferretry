import type { IDaemonLogPort } from '../../lib/daemon/ports.ts';

/**
 * How a log-streaming child is started; injectable so the follow path is testable without a hang.
 *
 * The argv is a non-empty tuple, so there is no "no command" case to guard — and therefore no
 * unreachable line a coverage gate would push someone into faking a test for.
 */
export type LogStreamSpawner = (argv: readonly [string, ...string[]]) => { readonly exited: Promise<number> };

/** Where the log's bytes go: written in order, each write settling once the destination took it. */
export interface LogOutputSink {
  write(chunk: Uint8Array): Promise<void>;
}

/** This process's standard output, written with backpressure: each write waits until it is flushed. */
const standardOutput: LogOutputSink = {
  write: async chunk =>
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, error => (error === undefined || error === null ? resolve() : reject(error)));
    }),
};

/**
 * Spawns the reader with its output RELAYED through this process rather than handed this process's own
 * standard output.
 *
 * HANDING IT OVER BROKE `fy daemon logs | grep …`. The runtime puts its standard output into
 * non-blocking mode, and a child given that descriptor shares the mode: the moment the pipe to a slower
 * reader filled, `cat` got EAGAIN and died with "write error: Resource temporarily unavailable". Here the
 * child writes into a pipe of its own, and its bytes are passed on one chunk at a time, each waiting for
 * the last to drain. A reader that goes away (`| head`) ends the relay and the child with it, and that
 * is a normal end, not an error: everything the reader asked for was delivered.
 */
export function relayingSpawner(sink: LogOutputSink = standardOutput): LogStreamSpawner {
  return ([command, ...args]) => {
    const child = Bun.spawn([command, ...args], { stdin: 'inherit', stdout: 'pipe', stderr: 'inherit' });
    const relayed = (async (): Promise<boolean> => {
      try {
        for await (const chunk of child.stdout) await sink.write(chunk);
        return true;
      } catch {
        child.kill();
        return false;
      }
    })();
    return {
      exited: (async () => {
        const delivered = await relayed;
        const code = await child.exited;
        return delivered ? code : 0;
      })(),
    };
  };
}

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
  constructor(private readonly spawn: LogStreamSpawner = relayingSpawner()) {}

  async exists(logFile: string): Promise<boolean> {
    return await Bun.file(logFile).exists();
  }

  async show(logFile: string, follow: boolean): Promise<number> {
    return await this.spawn(follow ? ['tail', '-F', '-n', '+1', logFile] : ['cat', logFile]).exited;
  }
}
