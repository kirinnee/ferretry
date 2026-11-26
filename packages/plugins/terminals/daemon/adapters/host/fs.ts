import { readFile } from 'node:fs/promises';
/**
 * THE ONE PLACE TERMINALS READS THE MACHINE DIRECTLY (a permanent per-file exemption, DECISIONS-2 #21).
 *
 * Terminals proves who reads a terminal from `/proc` (I234–I237), lists a ferret's processes from `/proc`, and reads
 * the cgroup and block-device files under `/sys`. None of that is a declared root or a state file, so every adapter that needs it imports these names from here instead of `node:fs`/`node:os`:
 * the calls, their order and their errors are today's, byte for byte, and `banned-globals` points at this one file.
 * What it reaches, so a reviewer can check the file against its reason: generic `node:fs` (lstat, readlink, realpath,
 * open flags, access, stat, readFile, readdir), `Bun.file`, this process pid and uid, `process.kill` signals, the CPU and
 * memory counts, `userInfo`, `process.platform` and `SHELL`.
 */
export { constants, type Stats } from 'node:fs';
export { access, type FileHandle, lstat, open, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
export { availableParallelism, totalmem, userInfo } from 'node:os';

/** The platform this daemon runs on (`process.platform`). */
export const hostPlatform: string = process.platform;

/** The one environment variable Terminals reads, the login shell (`SHELL`): by name, never the whole environment. */
export const hostEnvironment: Readonly<Record<string, string | undefined>> = { SHELL: process.env.SHELL };

/**
 * The daemon's own value of each NAMED variable that is set and non-empty, and nothing else of its environment: the user-manager
 * names the ferret-limits wrapper is started with (the same two the kernel gives its `systemd-run` proof).
 */
export function hostNamedEnvironment(names: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value !== '') picked[name] = value;
  }
  return picked;
}

/** A whole file as text (today's `Bun.file(path).text()`). */
export async function readText(path: string): Promise<string> {
  return await Bun.file(path).text();
}

/** This daemon's own pid and uid (`process.pid`, `process.getuid()`): the limits view proves the daemon is outside the slice it caps. */
export const hostPid: number = process.pid;
export const hostUid: number = process.getuid?.() ?? 0;
/** This account's uid, or nothing where the platform has none (the login shell looks it up only when known). */
export const hostUserId: number | undefined = process.getuid?.();

/** Sends one signal to one pid (`process.kill`). The caller has already re-proved which process that pid is. */
export function signalProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  process.kill(pid, signal);
}

/** False only when the OS proves a remembered pane process is gone; permission errors stay live/unknown. */
export async function processMayExist(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (hostPlatform === 'linux') {
      // A zombie still has a PID but holds no cwd. Container init may leave it unreaped indefinitely.
      const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      if (state === 'Z' || state === 'X') return false;
    }
    return true;
  } catch (error) {
    return !['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '');
  }
}

/** Finds a bare command name on the colon-separated search path it is GIVEN (never this process's own `PATH`). */
export function locateCommand(name: string, searchPath: string): string | undefined {
  return Bun.which(name, { PATH: searchPath }) ?? undefined;
}
