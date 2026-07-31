import { open } from 'node:fs/promises';
import type { CommandOutcome, DaemonStartHandle, DetachedLaunch, IDaemonProcessPort } from '../../lib/daemon/ports.ts';

/**
 * Every process touch the daemon-control commands make.
 *
 * `run` captures; `spawnDetached` deliberately does not, because the daemon must outlive this CLI.
 * Nothing here reads or writes daemon state — the only file it opens is the log it was told to append
 * the daemon's output to.
 */
export class BunDaemonProcess implements IDaemonProcessPort {
  async run(argv: readonly string[]): Promise<CommandOutcome> {
    const [command, ...args] = argv;
    if (command === undefined) throw new Error('cannot run an empty command');
    try {
      const child = Bun.spawn([command, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, stdout, stderr };
    } catch (error) {
      // A missing service manager is information, not a crash: the caller decides what it means.
      return { code: 127, stdout: '', stderr: (error as Error).message };
    }
  }

  /**
   * Starts the daemon detached, with both streams appended to the log.
   *
   * The log file descriptor is opened here rather than delegated to a `sh -c` redirect: kteam wrapped
   * the launch in `sh -c 'exec "$1" >> "$2" 2>&1'`, which put a shell in the middle of the process
   * tree for no gain and made the daemon's parent a shell that had already exited.
   */
  async spawnDetached(launch: DetachedLaunch): Promise<DaemonStartHandle> {
    const [command, ...args] = launch.argv;
    if (command === undefined) throw new Error('cannot launch an empty command');
    const log = await open(launch.logFile, 'a');
    try {
      const child = Bun.spawn([command, ...args], {
        env: { ...launch.environment },
        stdin: 'ignore',
        stdout: log.fd,
        stderr: log.fd,
      });
      child.unref();
      return { pid: child.pid };
    } finally {
      await log.close();
    }
  }

  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
