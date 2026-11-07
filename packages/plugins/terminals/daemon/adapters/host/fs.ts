/**
 * THE ONE PLACE TERMINALS READS THE MACHINE DIRECTLY (interim).
 *
 * Terminals proves who reads a terminal from `/proc` (I234–I237), lists a ferret's processes from `/proc`, and reads
 * the cgroup and block-device files under `/sys`. None of that is a declared root or a state file, and the kernel has
 * no port for it yet, so every adapter that needs it imports these names from here instead of `node:fs`/`node:os`:
 * the calls, their order and their errors are today's, byte for byte, and `banned-globals` points at this one file.
 * When the kernel offers a read-only host port, this file is the only one that changes.
 */
export { constants, type Stats } from 'node:fs';
export { access, type FileHandle, lstat, open, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
export { availableParallelism, homedir, totalmem, userInfo } from 'node:os';

/** The platform this daemon runs on (`process.platform`). */
export const hostPlatform: string = process.platform;

/** This daemon's own environment, read for the login shell (`SHELL`) and nothing else. */
export const hostEnvironment: Readonly<Record<string, string | undefined>> = process.env;

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
