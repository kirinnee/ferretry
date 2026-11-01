import {
  type BigIntStats,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import type { DescriptorCalls, FileIdentity, GuardDirectoryHandle } from '../lib/state-home-guard.ts';
import type { DirectorySyscalls } from './directory-syscalls.ts';
import type { LinkSyscall } from './link-syscall.ts';

/**
 * FOLDER STEPS RELATIVE TO A DESCRIPTOR, WHERE THERE IS NO DESCRIPTOR PATH (macOS).
 *
 * Linux reaches an open folder's entries through `/proc/self/fd/N/<leaf>`. macOS has no such path, and this runtime
 * has no `openat`. What it does honour is the kernel's working directory: with a held folder installed by `fchdir`,
 * a one-segment relative name is resolved by the kernel from THAT folder and from nowhere else — the mechanism the
 * session-file pinner already proves on macOS (`directory-syscalls.ts`). So each step here is one BRACKET:
 *
 *   1. `fchdir` the held descriptor;
 *   2. PROVE it: `lstat('.')`, bigint, must be the held folder's device and inode — on every step, because that a
 *      relative name reaches the kernel's directory is a property of the runtime, not a promise;
 *   3. ONE synchronous call on a relative name (`lstat`, `readdir`, `open` with a real mode, `mkdir`, `rename`,
 *      `symlink`, `unlink`, `rmdir`);
 *   4. `fchdir` back to the runtime's own working directory, held as a descriptor, in a synchronous try/finally.
 *
 * Nothing between 1 and 4 awaits or makes an asynchronous call, so nothing else in this single-threaded runtime can
 * run inside the window. If step 4 fails, the runtime is standing in the wrong folder: every later bracket refuses,
 * and the step that failed to restore reports it, rather than anything going on there.
 *
 * The one step across TWO folders — a hard link from one into the other — is `linkat` on both descriptors, which
 * needs no bracket. Integers and strings only, as `directory-syscalls.ts` holds itself to: no struct is decoded.
 */
export class DescriptorBracket {
  private home: number | undefined;
  private broken: string | undefined;

  constructor(
    private readonly syscalls: DirectorySyscalls,
    private readonly links: LinkSyscall,
  ) {}

  /** Runs `act` — synchronous, on relative names — with `fd` installed and proven to be `identity`. */
  run<T>(fd: number, identity: FileIdentity, act: () => T): T {
    if (this.broken !== undefined) throw new Error(`refusing to reach a folder through its descriptor: ${this.broken}`);
    this.home ??= openSync('.', constants.O_RDONLY | constants.O_DIRECTORY);
    const home = this.home;
    if (this.syscalls.fchdir(fd) !== 0) {
      throw Object.assign(new Error('the folder could not be installed as the working directory'), { code: 'EBADF' });
    }
    let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
    try {
      const here = lstatSync('.', { bigint: true });
      if (here.dev !== identity.device || here.ino !== identity.inode) {
        throw new Error(
          'refusing to reach a folder through its descriptor: a relative name did not reach the folder installed',
        );
      }
      outcome = { ok: true, value: act() };
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      // Restored before anything else can run. A runtime left in the folder is refused for the rest of its run.
      if (this.syscalls.fchdir(home) !== 0) this.broken = 'the working directory could not be restored after a step';
    }
    if (this.broken !== undefined) throw new Error(`refusing to go on: ${this.broken}`);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  linkat(fromFd: number, fromName: string, toFd: number, toName: string): void {
    this.links.linkat(fromFd, fromName, toFd, toName);
  }
}

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const READ_FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const NEW_FILE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Which descriptor each handle holds, for the step that needs two of them. */
const descriptors = new WeakMap<GuardDirectoryHandle, number>();

/**
 * A folder handle on the open descriptor `fd`, whose every step goes through `bracket`. Takes ownership of `fd`.
 * `identityOf` turns the runtime's `lstat` answer into the guard's identity.
 */
export function descriptorHandle(
  fd: number,
  bracket: DescriptorBracket,
  identityOf: (entry: BigIntStats) => FileIdentity,
): GuardDirectoryHandle {
  let identity: FileIdentity;
  try {
    identity = identityOf(fstatSync(fd, { bigint: true }));
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  const step = async <T>(act: () => T): Promise<T> => bracket.run(fd, identity, act);
  const at: DescriptorCalls = {
    identity: async leaf =>
      await step(() => {
        try {
          return identityOf(lstatSync(leaf, { bigint: true }));
        } catch (error) {
          if (isMissing(error)) return undefined;
          throw error;
        }
      }),
    list: async () => await step(() => readdirSync('.')),
    mkdir: async (leaf, mode) => {
      await step(() => mkdirSync(leaf, { mode }));
    },
    openDirectory: async leaf =>
      descriptorHandle(
        await step(() => openSync(leaf, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)),
        bracket,
        identityOf,
      ),
    unlink: async leaf => await step(() => unlinkSync(leaf)),
    rmdir: async leaf => await step(() => rmdirSync(leaf)),
    rename: async (from, to) => await step(() => renameSync(from, to)),
    symlink: async (target, leaf) => await step(() => symlinkSync(target, leaf)),
    link: async (fromLeaf, into, toLeaf) => {
      // A folder not held by a descriptor here has none to link into: the kernel answers `EBADF`.
      bracket.linkat(fd, fromLeaf, descriptors.get(into) ?? -1, toLeaf);
    },
    openFile: async (leaf, how, mode) => await step(() => openSync(leaf, how === 'read' ? READ_FILE : NEW_FILE, mode)),
  };
  const handle: GuardDirectoryHandle = {
    identity,
    entryPath: () => undefined,
    at,
    chmod: async mode => fchmodSync(fd, mode),
    close: async () => closeSync(fd),
  };
  descriptors.set(handle, fd);
  return handle;
}
