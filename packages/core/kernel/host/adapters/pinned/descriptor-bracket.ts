import { type BigIntStats, constants, lstatSync, openSync, readdirSync, rmdirSync } from 'node:fs';
import { O_CLOEXEC } from './descriptor-calls.ts';
import { loadDirectorySyscalls } from './directory-syscalls.ts';
import { PROCESS_WORKING_DIRECTORY, type WorkingDirectory } from './working-directory.ts';

/**
 * THE STEPS ON A HELD FOLDER THAT ONLY A WORKING DIRECTORY CAN TAKE (macOS has no `/proc/self/fd`, and no `openat`
 * reaches a directory listing or `rmdir`).
 *
 * Copied from today's `DescriptorBracket.run` (`packages/fleet/src/adapters/descriptor-calls.ts:48-86`): one step is
 *
 *   1. `fchdir` the held descriptor;
 *   2. PROVE it: `lstat('.')`, bigint, must be the held folder's device and inode, on every step (that a relative name
 *      reaches the kernel's directory is a property of the runtime, not a promise);
 *   3. ONE synchronous call on a relative name or on `.` (`BracketOps`);
 *   4. `fchdir` back to the process's own working directory, held as a descriptor, in a `finally`.
 *
 * Nothing between 1 and 4 awaits, so no other JavaScript on this thread runs inside the window: `run` takes a
 * SYNCHRONOUS `act` and refuses one that hands back a promise. The working directory is the PROCESS's, not this
 * bracket's: a worker thread (the kernel starts plugin `Worker`s) or one of the runtime's own I/O threads that resolves
 * a RELATIVE path while a step is inside would resolve it in the folder installed. None of this kernel's or the
 * plugins' file calls takes a relative path (an audit, not an enforced rule: the same declaration as today's), and a
 * `nodeFs` is built on the main thread only. A second bracket opened while one is open (a bug that nests two steps)
 * is refused, never run: two installs would restore each other's directory.
 *
 * A failed restore is handled by the shared {@link WorkingDirectory} (fall back to `/`, or stop the process, and every
 * later bracket refuses), the same one the session-file pinner uses.
 */
export interface BracketOps {
  /** `lstat('.')`: the folder the kernel now believes is the working directory. */
  here(): BigIntStats;
  /** `lstat(name)`: the entry itself, never followed; `undefined` when nothing is there. */
  lstat(name: string): BigIntStats | undefined;
  /** The names in `.`, sorted. */
  list(): readonly string[];
  /** `rmdir(name)`: removes an EMPTY folder, never a link (a link answers `ENOTDIR`). */
  rmdir(name: string): void;
}

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** The runtime's own relative-name calls: what a working directory makes safe. */
export const PROCESS_BRACKET_OPS: BracketOps = {
  here: () => lstatSync('.', { bigint: true }),
  lstat: name => {
    try {
      return lstatSync(name, { bigint: true });
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  },
  list: () => readdirSync('.').sort(),
  rmdir: name => {
    rmdirSync(name);
  },
};

/** The folder a step must reach, by what it was when it was opened. */
export interface BracketTarget {
  readonly device: bigint;
  readonly inode: bigint;
}

export class DescriptorBracket {
  private home: number | undefined;
  private open = false;

  /**
   * `fchdir`: installs a descriptor as the working directory (0, or -1 on failure). `ops`: the relative-name calls.
   * `directory`: the process's working directory, shared with the session-file pinner. `openHome`: how the
   * process's own working directory is held (a test names its own).
   */
  constructor(
    private readonly fchdir: (fd: number) => number,
    private readonly ops: BracketOps = PROCESS_BRACKET_OPS,
    private readonly directory: WorkingDirectory = PROCESS_WORKING_DIRECTORY,
    private readonly openHome: () => number = () =>
      openSync('.', constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC),
  ) {}

  /** Runs `act`, synchronous, on relative names, with `fd` installed and proven to be `target`. */
  run<T>(fd: number, target: BracketTarget, act: (ops: BracketOps) => T): T {
    if (this.open) {
      throw Object.assign(
        new Error('refusing to reach a folder through its descriptor: a folder step is already open'),
        { code: 'EBUSY' },
      );
    }
    const broken = this.directory.broken;
    if (broken !== undefined) throw new Error(`refusing to reach a folder through its descriptor: ${broken}`);
    this.open = true;
    try {
      this.home ??= this.openHome();
      const home = this.home;
      if (this.fchdir(fd) !== 0) {
        throw Object.assign(new Error('the folder could not be installed as the working directory'), {
          code: 'EBADF',
        });
      }
      let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
      let restored = false;
      try {
        const here = this.ops.here();
        if (here.dev !== target.device || here.ino !== target.inode) {
          throw Object.assign(
            new Error(
              'refusing to reach a folder through its descriptor: a relative name did not reach the folder installed',
            ),
            { code: 'EBADF' },
          );
        }
        const value = act(this.ops);
        if (typeof (value as { then?: unknown } | null)?.then === 'function') {
          throw new Error('refusing to reach a folder through its descriptor: a step may not wait');
        }
        outcome = { ok: true, value };
      } catch (error) {
        outcome = { ok: false, error };
      } finally {
        // Restored before anything else can run, or `/` instead and every later bracket refused (`WorkingDirectory`).
        restored = this.directory.restore(this.fchdir, home);
      }
      if (!restored) throw new Error(`refusing to go on: ${this.directory.broken as string}`);
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    } finally {
      this.open = false;
    }
  }
}

let processBracket: DescriptorBracket | undefined;

/** The one bracket this process shares (a second would not see the first one open); throws when `fchdir` cannot be loaded. */
export function loadProcessBracket(): DescriptorBracket {
  processBracket ??= new DescriptorBracket(loadDirectorySyscalls().fchdir);
  return processBracket;
}
