import { open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import type { CommandOutcome, DaemonStartHandle, DetachedLaunch, IDaemonProcessPort } from '../../lib/daemon/ports.ts';

/**
 * Every process touch the daemon-control commands make.
 *
 * `run` captures; `spawnDetached` deliberately does not, because the daemon must outlive this CLI.
 * Nothing here reads or writes daemon state — the only file it opens is the log it was told to append
 * the daemon's output to.
 */
export class BunDaemonProcess implements IDaemonProcessPort {
  /**
   * Where `holdsOpen` looks. Both default to the host's own; a test points them elsewhere so the
   * `lsof` answer is exercised on Linux and the `/proc` refusals without another user's process.
   */
  constructor(private readonly options: { readonly procDirectory?: string; readonly lsof?: string } = {}) {}

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

  /**
   * Whether `pid` has `path` open, read from `/proc` where there is one and from `lsof` otherwise.
   *
   * Linux answers from `/proc/<pid>/fd`, which needs nothing installed. macOS has no `/proc` and ships
   * `lsof`. A host with neither gets `undefined`, and so does a process this user may not inspect —
   * which is a process this user could not signal either.
   */
  async holdsOpen(pid: number, path: string): Promise<boolean | undefined> {
    const proc = this.options.procDirectory ?? '/proc';
    if (await isDirectory(`${proc}/self/fd`)) return await holdsOpenPerProc(proc, pid, path);
    const listed = await this.run([this.options.lsof ?? 'lsof', '-t', '-a', '-p', String(pid), '--', path]);
    if (listed.code === 127) return undefined;
    return listed.code === 0 && listed.stdout.split('\n').some(line => line.trim() === String(pid));
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return await stat(path).then(
    found => found.isDirectory(),
    () => false,
  );
}

/** The `/proc` answer: does any of `pid`'s descriptors resolve to the file `path` names? */
async function holdsOpenPerProc(proc: string, pid: number, path: string): Promise<boolean | undefined> {
  // No such file means no daemon has ever held it open, so this pid does not.
  const target = await realpath(path).catch(() => undefined);
  if (target === undefined) return false;
  const directory = `${proc}/${String(pid)}/fd`;
  // Gone means it holds nothing; anything else is a process this user may not look inside.
  const descriptors = await readdir(directory).catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? false : undefined,
  );
  if (descriptors === false || descriptors === undefined) return descriptors;
  for (const descriptor of descriptors) {
    // A descriptor closed between the listing and the read is simply not this file.
    if ((await readlink(`${directory}/${descriptor}`).catch(() => undefined)) === target) return true;
  }
  return false;
}
