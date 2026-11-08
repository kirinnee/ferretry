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
export function signalProcess(pid: number, signal: 'SIGTERM'): void {
  process.kill(pid, signal);
}
