import { dlopen, FFIType, type Pointer, read, suffix } from 'bun:ffi';
import { constants } from 'node:os';

/** The kernel owns this mutex: closing the descriptor or exiting drops it without unlinking the shared inode. */
function loadLock(platform: string): (fd: number) => boolean {
  const darwin = platform === 'darwin';
  const errnoName = darwin ? '__error' : '__errno_location';
  const { symbols } = dlopen(darwin ? 'libSystem.B.dylib' : `libc.${suffix}.6`, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errnoName]: { args: [], returns: FFIType.ptr },
  });
  const errnoOf = symbols[errnoName] as () => Pointer | null;
  return fd => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (symbols.flock(fd, 2 | 4) === 0) return true; // LOCK_EX | LOCK_NB, Linux and macOS.
      const at = errnoOf();
      const errno = at === null ? 0 : read.i32(at, 0);
      if (errno === constants.errno.EWOULDBLOCK) return false;
      if (errno !== constants.errno.EINTR) throw Object.assign(new Error('browser reclaim mutex failed'), { errno });
    }
    return false;
  };
}

let tryLock: ((fd: number) => boolean) | undefined;

/**
 * Serializes guard publication, abandoned-guard cleanup and lease removal across stores AND processes. The mutex
 * file stays in place: unlinking a mutex lets two callers lock different inodes at the same pathname. A crashed
 * reclaimer needs no mutex cleanup; its next successor can safely inspect and remove the abandoned owner record.
 */
export function tryProfileReclaimLock(fd: number, platform: string): boolean {
  tryLock ??= loadLock(platform);
  return tryLock(fd);
}
