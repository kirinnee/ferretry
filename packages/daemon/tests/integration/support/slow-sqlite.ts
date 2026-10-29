/**
 * A SQLite connection whose every commit takes `commitMs` longer — the saturated disk, on cue.
 *
 * What froze the daemon was a commit that could not return: SQLite's checkpoint `fsync`s the log and the
 * database, and on a disk at 46% "full" IO pressure that took seconds. The thread that called it waited
 * that long whatever it was. This waits the same way — the thread is blocked, not yielding — so a test can
 * show which thread a commit blocks without needing a disk that is actually saturated.
 */
import { Database } from 'bun:sqlite';

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Blocks the calling thread for `milliseconds`, as a slow `fsync` does. */
function blockThread(milliseconds: number): void {
  Atomics.wait(sleeper, 0, 0, milliseconds);
}

export class SlowCommitDatabase extends Database {
  constructor(
    file: string,
    private readonly commitMs: number,
  ) {
    super(file, { create: true, strict: true });
  }

  override transaction(work: (...args: any[]) => void): any {
    const transaction = super.transaction(work);
    return (...args: unknown[]) => {
      const result = transaction(...args);
      blockThread(this.commitMs);
      return result;
    };
  }
}
