import { dlopen, FFIType, type Pointer, read, suffix } from 'bun:ffi';
import { constants as osConstants } from 'node:os';

/**
 * An exclusive lock held on an open file (`flock(2)`): one per open file, so two opens of one file exclude each other
 * even in one process, and the kernel drops it when that open is closed or its process dies — nobody has to remove
 * anything after a crash, so a crashed claimant can never wedge the next one.
 */
export interface FileLock {
  /** Takes the lock on `fd` when nobody else holds it: `true`, or `false` while another holds it. Throws on anything else. */
  tryLock(fd: number): boolean;
}

const LIBC = process.platform === 'darwin' ? 'libSystem.B.dylib' : `libc.${suffix}.6`;
/** Where the C library keeps this thread's `errno`, by the name each platform exports it under. */
const ERRNO = process.platform === 'darwin' ? '__error' : '__errno_location';
/** `flock(2)`'s operations, the same on Linux and macOS. */
const LOCK_EX = 2;
const LOCK_NB = 4;
/** How often one `tryLock` asks again after a signal interrupted it: interrupted again and again, it reads as held. */
const MAX_INTERRUPTED_TRIES = 100;

/**
 * What a refused `flock` on `fd` means: `again` when a signal interrupted it (it took nothing, so it is asked again),
 * `held` while another open holds the lock; anything else throws with the errno.
 */
export function flockRefusal(errno: number, fd: number): 'again' | 'held' {
  if (errno === osConstants.errno.EINTR) return 'again';
  if (errno === osConstants.errno.EWOULDBLOCK) return 'held';
  throw Object.assign(new Error(`errno ${String(errno)}: flock ${String(fd)}`), { errno });
}

/** Loads `flock` and the errno it sets, or throws. Integers only: no struct layout to get wrong on another platform. */
export function loadFileLock(): FileLock {
  const { symbols } = dlopen(LIBC, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [ERRNO]: { args: [], returns: FFIType.ptr },
  });
  const errnoOf = symbols[ERRNO] as () => Pointer | null;
  return {
    tryLock: fd => {
      for (let attempt = 1; ; attempt += 1) {
        if (symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
        const at = errnoOf();
        if (flockRefusal(at === null ? 0 : read.i32(at, 0), fd) === 'held' || attempt >= MAX_INTERRUPTED_TRIES)
          return false;
      }
    },
  };
}
