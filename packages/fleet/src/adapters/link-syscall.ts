import { dlopen, FFIType, type Pointer, read } from 'bun:ffi';
import { constants as osConstants } from 'node:os';
import { LIBC } from './directory-syscalls.ts';

/** Where the C library keeps this thread's `errno`, by the name each platform exports it under. */
const ERRNO = process.platform === 'darwin' ? '__error' : '__errno_location';

/**
 * The calls a folder step needs across TWO open folders — a hard link, and a rename, from a name in one to a name in
 * the other (`linkat`, `renameat`) — which no working directory can express. Integers and strings only, as
 * `directory-syscalls.ts` holds itself to — no struct. And the lock a conversation lease is decided under (`flock`).
 */
export interface LinkSyscall {
  /** Links `fromName` in the folder `fromFd` as `toName` in the folder `toFd`; throws with the errno's code. */
  linkat(fromFd: number, fromName: string, toFd: number, toName: string): void;
  /** Renames `fromName` in the folder `fromFd` to `toName` in the folder `toFd`; throws with the errno's code. */
  renameat(fromFd: number, fromName: string, toFd: number, toName: string): void;
}

const errnoNames = new Map(Object.entries(osConstants.errno).map(([name, value]) => [value, name]));

const cString = (text: string): Uint8Array => new TextEncoder().encode(`${text}\0`);

/** Loads `linkat`, `renameat` and the errno they set, or throws (see `loadDirectorySyscalls`). */
export function loadLinkSyscall(): LinkSyscall {
  const { symbols } = dlopen(LIBC, {
    linkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    [ERRNO]: { args: [], returns: FFIType.ptr },
  });
  const errnoOf = symbols[ERRNO] as () => Pointer | null;
  const refused = (verb: string, fromName: string, toName: string): never => {
    const at = errnoOf();
    const errno = at === null ? 0 : read.i32(at, 0);
    const code = errnoNames.get(errno) ?? `errno ${String(errno)}`;
    throw Object.assign(new Error(`${code}: ${verb} ${fromName} -> ${toName}`), { code, errno });
  };
  return {
    linkat: (fromFd, fromName, toFd, toName) => {
      if (symbols.linkat(fromFd, cString(fromName), toFd, cString(toName), 0) !== 0) refused('link', fromName, toName);
    },
    renameat: (fromFd, fromName, toFd, toName) => {
      if (symbols.renameat(fromFd, cString(fromName), toFd, cString(toName)) !== 0) refused('rename', fromName, toName);
    },
  };
}

/** `flock(2)`'s operations, the same on Linux and macOS. */
const LOCK_EX = 2;
const LOCK_NB = 4;

/**
 * An exclusive lock held on an open file (`flock(2)`): one per open file, so two opens of one file exclude each
 * other even in one process, and the kernel drops it when that open is closed or its process dies — nobody has to
 * remove anything after a crash.
 */
export interface FileLock {
  /** Takes the lock on `fd` when nobody else holds it: `true`, or `false` while another holds it. Throws on anything else. */
  tryLock(fd: number): boolean;
}

/**
 * What a refused `flock` on `fd` means: `again` when a signal interrupted it (it took nothing, so it is asked again),
 * `held` while another open holds the lock; anything else throws with the errno's code.
 */
export function flockRefusal(errno: number, fd: number): 'again' | 'held' {
  if (errno === osConstants.errno.EINTR) return 'again';
  if (errno === osConstants.errno.EWOULDBLOCK) return 'held';
  const code = errnoNames.get(errno) ?? `errno ${String(errno)}`;
  throw Object.assign(new Error(`${code}: flock ${String(fd)}`), { code, errno });
}

/** Loads `flock` and the errno it sets, or throws (see `loadDirectorySyscalls`). Integers only. */
export function loadFileLock(): FileLock {
  const { symbols } = dlopen(LIBC, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [ERRNO]: { args: [], returns: FFIType.ptr },
  });
  const errnoOf = symbols[ERRNO] as () => Pointer | null;
  return {
    tryLock: fd => {
      // Interrupted again and again, it reads as held: the caller polls on to its budget.
      for (let attempt = 1; ; attempt += 1) {
        if (symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
        const at = errnoOf();
        if (flockRefusal(at === null ? 0 : read.i32(at, 0), fd) === 'held' || attempt >= MAX_INTERRUPTED_TRIES)
          return false;
      }
    },
  };
}

/** How often one `tryLock` asks again after a signal interrupted it. */
const MAX_INTERRUPTED_TRIES = 100;

/**
 * `load`, called once for the process: every later call answers what the first did, its failure included — so a C
 * call is loaded (and its trampoline compiled) once, not on every step that uses it.
 */
export function loadedOnce<T>(load: () => T): () => T {
  let outcome: { readonly value: T } | { readonly error: unknown } | undefined;
  return () => {
    outcome ??= (() => {
      try {
        return { value: load() };
      } catch (error) {
        return { error };
      }
    })();
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  };
}

/** This process's `flock`, loaded on first use. */
export const processFileLock: () => FileLock = loadedOnce(loadFileLock);
