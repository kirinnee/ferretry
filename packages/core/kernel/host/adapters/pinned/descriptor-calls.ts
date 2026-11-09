import { dlopen, FFIType, type Pointer, read } from 'bun:ffi';
import { constants as osConstants } from 'node:os';
import { LIBC } from './directory-syscalls.ts';

/**
 * THE C CALLS A HELD FOLDER NEEDS WHERE NO PATH REACHES AN OPEN DESCRIPTOR (macOS has no `/proc/self/fd`).
 *
 * Copied from today's `link-syscall.ts` (`loadLinkSyscall`: `linkat`, `renameat`, the errno read) and extended with the
 * two calls today's `DescriptorBracket` reaches through the working directory instead (`openat`, `unlinkat`), because a
 * rename between two held folders is only half of a write: the temp file must be created, looked at and removed
 * through the held folder too, or a parent swapped for a link after the check plants it outside.
 *
 * SIGNATURES (POSIX.1-2008 `<unistd.h>` / `<fcntl.h>` / `<stdio.h>`; macOS ships all four in libSystem since 10.10):
 *
 *   int openat  (int fd, const char *path, int oflag, ...);    // the variadic `mode` is read only with O_CREAT
 *   int renameat(int fromfd, const char *from, int tofd, const char *to);
 *   int linkat  (int fd1, const char *name1, int fd2, const char *name2, int flag);
 *   int unlinkat(int fd, const char *path, int flag);
 *
 * Each is declared below with exactly those argument types (`FFIType.i32` for `int`, `FFIType.ptr` for the NUL-ended
 * names). On a Linux box these are the same symbols in `libc.so.6`, so `loadDescriptorCalls` is exercised for real
 * there too; what only a Mac can prove (the `libSystem.B.dylib` name, the `__error` symbol) is covered by the
 * `skipIf(process.platform !== 'darwin')` tests alone, which cannot run on the CI/Linux box (a declared GAP).
 *
 * WHICH FLAG KEEPS A LEAF FROM BEING FOLLOWED. `rename(2)`, `link(2)` (with `flag` 0) and `unlinkat(2)` act on the
 * final component itself and never follow a link there, on macOS as on Linux, so no `RENAME_NOFOLLOW_ANY` is needed:
 * every name given is ONE validated segment (no intermediate component exists to follow). A leaf that is only LOOKED
 * AT is opened with `O_NOFOLLOW` (a link answers `ELOOP`, it is never opened). A name with a NUL, a `/`, or that is
 * empty, `.` or `..` is refused here before the kernel sees it: a NUL would silently end the C string early.
 *
 * VARIADIC `mode`. Apple's arm64 ABI passes the variadic arguments of a C call on the STACK, where this binding puts
 * `mode` in a register: a file `openat` creates (`O_CREAT`) can therefore get an arbitrary mode. The caller never
 * relies on it: the descriptor is `fchmod`ed to the exact mode before any content is written, and the file is empty,
 * owned by this process and not yet linked anywhere until then.
 *
 * A symbol this process cannot load makes `loadDescriptorCalls` THROW one sentence (see `refusalSentence`): the
 * caller keeps today's `no_descriptor_reach` refusal and the host boots; nothing is ever loaded at import time.
 */
export interface DescriptorCalls {
  /** Opens `name` in the folder `folderFd` with `flags` (and `mode` when it creates); returns the descriptor. Throws with the errno's `code`. */
  openat(folderFd: number, name: string, flags: number, mode: number): number;
  /** Renames `fromName` in `fromFd` to `toName` in `toFd`; replaces silently when `toName` exists (the caller looks first). */
  renameat(fromFd: number, fromName: string, toFd: number, toName: string): void;
  /** A hard link `toName` in `toFd` to `fromName` in `fromFd`; refused `EEXIST` when `toName` is taken. */
  linkat(fromFd: number, fromName: string, toFd: number, toName: string): void;
  /** Removes the non-folder `name` from `folderFd`. */
  unlinkat(folderFd: number, name: string): void;
}

/** Where the C library keeps this thread's `errno`, by the name each platform exports it under. */
const ERRNO = process.platform === 'darwin' ? '__error' : '__errno_location';

const errnoNames = new Map(Object.entries(osConstants.errno).map(([name, value]) => [value, name]));

/** The one sentence a host that cannot load the calls refuses with: a fact, no path in it. */
const refusalSentence = (cause: string): string =>
  `this host cannot reach an entry through a held folder: the C library's descriptor calls could not be loaded (${cause})`;

/** A name `openat` and friends may be given: one segment, no NUL (it would end the C string early). */
export const isSingleName = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0');

const failed = (code: string, message: string): never => {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
};

const cString = (name: string, verb: string): Uint8Array => {
  if (!isSingleName(name)) return failed('EINVAL', `${verb} refused a name that is not one plain segment`);
  return new TextEncoder().encode(`${name}\0`);
};

/**
 * Loads the four calls and the errno they set, or throws {@link refusalSentence}. `library` and `errnoSymbol` are the
 * platform's own by default; a test on another platform passes its own.
 */
export function loadDescriptorCalls(library: string = LIBC, errnoSymbol: string = ERRNO): DescriptorCalls {
  let symbols: Record<string, (...args: never[]) => unknown>;
  try {
    symbols = dlopen(library, {
      openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      linkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      [errnoSymbol]: { args: [], returns: FFIType.ptr },
    }).symbols as unknown as Record<string, (...args: never[]) => unknown>;
  } catch (error) {
    throw new Error(refusalSentence(error instanceof Error ? (error.message.split('\n')[0] ?? 'unknown') : 'unknown'));
  }
  const errnoOf = symbols[errnoSymbol] as unknown as () => Pointer | null;
  const refused = (verb: string): never => {
    const at = errnoOf();
    const errno = at === null ? 0 : read.i32(at, 0);
    const code = errnoNames.get(errno) ?? `errno ${String(errno)}`;
    throw Object.assign(new Error(`${code}: ${verb}`), { code, errno });
  };
  const call = symbols as unknown as {
    openat(fd: number, name: Uint8Array, flags: number, mode: number): number;
    renameat(from: number, fromName: Uint8Array, to: number, toName: Uint8Array): number;
    linkat(from: number, fromName: Uint8Array, to: number, toName: Uint8Array, flag: number): number;
    unlinkat(fd: number, name: Uint8Array, flag: number): number;
  };
  return {
    openat: (folderFd, name, flags, mode) => {
      const fd = call.openat(folderFd, cString(name, 'open'), flags, mode);
      return fd < 0 ? refused('open') : fd;
    },
    renameat: (fromFd, fromName, toFd, toName) => {
      if (call.renameat(fromFd, cString(fromName, 'rename'), toFd, cString(toName, 'rename')) !== 0) refused('rename');
    },
    linkat: (fromFd, fromName, toFd, toName) => {
      if (call.linkat(fromFd, cString(fromName, 'link'), toFd, cString(toName, 'link'), 0) !== 0) refused('link');
    },
    unlinkat: (folderFd, name) => {
      if (call.unlinkat(folderFd, cString(name, 'unlink'), 0) !== 0) refused('unlink');
    },
  };
}

/** `O_CLOEXEC`, which this runtime neither exports nor adds to an open given numeric flags (copied from today's `descriptor-calls.ts`). */
export const O_CLOEXEC = process.platform === 'darwin' ? 0x1000000 : 0o2000000;
