import {
  type BigIntStats,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import type { DescriptorCalls, FileIdentity, FileOpening, GuardDirectoryHandle } from '../lib/state-home-guard.ts';
import type { DirectorySyscalls } from './directory-syscalls.ts';
import type { LinkSyscall } from './link-syscall.ts';
import { PROCESS_WORKING_DIRECTORY, type WorkingDirectory } from './working-directory.ts';

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
 * Nothing between 1 and 4 awaits or makes an asynchronous call, so no other JavaScript runs inside the window. Bun's I/O
 * threads can still be finishing an asynchronous file call started earlier, and a RELATIVE path there would resolve in
 * the installed folder: none of this daemon's asynchronous file calls takes one — an audit, not an enforced rule. If
 * step 4 fails, the process falls back to `/` (or stops, `./working-directory.ts`), the step that failed reports it,
 * and every later bracket — this one's and the session-file pinner's — refuses.
 *
 * The steps across TWO folders — a hard link or a rename from one into the other — are `linkat` and `renameat` on both
 * descriptors, each folder proven first, which
 * needs no bracket. Integers and strings only, as `directory-syscalls.ts` holds itself to: no struct is decoded.
 */
export class DescriptorBracket {
  private home: number | undefined;

  /** `directory`: the process's working directory, as this bracket and the session-file pinner share it. */
  constructor(
    private readonly syscalls: DirectorySyscalls,
    private readonly links: LinkSyscall,
    private readonly directory: WorkingDirectory = PROCESS_WORKING_DIRECTORY,
  ) {}

  /** Runs `act` — synchronous, on relative names — with `fd` installed and proven to be `identity`. */
  run<T>(fd: number, identity: FileIdentity, act: () => T): T {
    const broken = this.directory.broken;
    if (broken !== undefined) throw new Error(`refusing to reach a folder through its descriptor: ${broken}`);
    this.home ??= openSync('.', constants.O_RDONLY | constants.O_DIRECTORY);
    const home = this.home;
    if (this.syscalls.fchdir(fd) !== 0) {
      throw Object.assign(new Error('the folder could not be installed as the working directory'), { code: 'EBADF' });
    }
    let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
    let restored = false;
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
      // Restored before anything else can run — or `/` instead, and every later bracket refused (`WorkingDirectory`).
      restored = this.directory.restore(this.syscalls.fchdir, home);
    }
    if (!restored) throw new Error(`refusing to go on: ${this.directory.broken as string}`);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * Links across two held folders, each proven first to still be the folder its handle was opened on — a descriptor
   * number closed and reused by another folder would otherwise link somewhere else.
   */
  linkat(from: HeldFolder, fromName: string, to: HeldFolder, toName: string): void {
    this.proveHeld('link', from, to);
    this.links.linkat(from.fd, fromName, to.fd, toName);
  }

  /** Renames across two held folders, each proven first like {@link linkat}. */
  renameat(from: HeldFolder, fromName: string, to: HeldFolder, toName: string): void {
    this.proveHeld('rename', from, to);
    this.links.renameat(from.fd, fromName, to.fd, toName);
  }

  private proveHeld(verb: string, ...held: readonly HeldFolder[]): void {
    for (const folder of held) {
      const now = fstatSync(folder.fd, { bigint: true });
      if (now.dev !== folder.identity.device || now.ino !== folder.identity.inode) {
        throw Object.assign(new Error(`refusing to ${verb}: a held folder is no longer the one it was opened on`), {
          code: 'EBADF',
        });
      }
    }
  }
}

/** A folder held open by descriptor, and what it was when it was opened. */
interface HeldFolder {
  readonly fd: number;
  readonly identity: FileIdentity;
}

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * `O_CLOEXEC`, which this runtime neither exports nor adds to an open given numeric flags: without it a child spawned
 * while a step holds a descriptor would keep it — and with it, a lease lock held on that open file.
 */
export const O_CLOEXEC = process.platform === 'darwin' ? 0x1000000 : 0o2000000;

/** The open flags of each way a folder step opens a file — the same everywhere (`node-guard-disk.ts` too). */
export const FILE_OPENINGS: Readonly<Record<FileOpening, number>> = {
  read: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC,
  new:
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC,
  append: constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC,
};

/** Which folder each handle holds, for the step that needs two of them. */
const descriptors = new WeakMap<GuardDirectoryHandle, HeldFolder>();

/** The folder `into` holds — refused as the kernel would (`EBADF`) when it holds none here. */
const held = (verb: string, into: GuardDirectoryHandle): HeldFolder => {
  const target = descriptors.get(into);
  if (target === undefined)
    throw Object.assign(new Error(`refusing to ${verb}: that folder is not held`), { code: 'EBADF' });
  return target;
};

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
    readlink: async leaf => await step(() => readlinkSync(leaf)),
    link: async (fromLeaf, into, toLeaf) => bracket.linkat({ fd, identity }, fromLeaf, held('link', into), toLeaf),
    renameInto: async (fromLeaf, into, toLeaf) =>
      bracket.renameat({ fd, identity }, fromLeaf, held('rename', into), toLeaf),
    openFile: async (leaf, how, mode) => await step(() => openSync(leaf, FILE_OPENINGS[how], mode)),
  };
  const handle: GuardDirectoryHandle = {
    identity,
    entryPath: () => undefined,
    at,
    chmod: async mode => fchmodSync(fd, mode),
    sync: async () => fsyncSync(fd),
    close: async () => closeSync(fd),
  };
  descriptors.set(handle, { fd, identity });
  return handle;
}
