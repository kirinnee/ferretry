import { constants } from 'node:os';

/**
 * `process.memoryUsage()`, read again when it was interrupted.
 *
 * Bun reads the resident set from `/proc/self/stat` on Linux and, when that read fails, throws a
 * `SystemError` carrying whatever `errno` the thread holds at that moment. A signal handled on this
 * thread between Bun's `errno = 0` and its check of `strtol` leaves `EINTR` there, so a perfectly good
 * read is thrown away as "Failed to get memory usage" with `errno: 4` — seen in CI on the daemon's
 * runtime integration group. Interrupted is not failed: the answer to `EINTR` is to ask again, so this
 * does, a bounded number of times, and lets every other failure through untouched.
 */
export function memoryUsage(
  read: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
  attempts = MEMORY_USAGE_ATTEMPTS,
): NodeJS.MemoryUsage {
  for (let attempt = 1; ; attempt++) {
    try {
      return read();
    } catch (error) {
      if (attempt >= attempts || !interrupted(error)) throw error;
    }
  }
}

/** Enough for a burst of signals, few enough that a read that keeps failing still surfaces. */
const MEMORY_USAGE_ATTEMPTS = 3;

function interrupted(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { errno, code } = error as { errno?: unknown; code?: unknown };
  return code === 'EINTR' || errno === constants.errno.EINTR || errno === -constants.errno.EINTR;
}
