import { type BigIntStats, close, constants, fchmod, fstat, fsync, read as readFd, write } from 'node:fs';
import type { DescriptorBracket } from './descriptor-bracket.ts';
import { type DescriptorCalls, isSingleName, O_CLOEXEC } from './descriptor-calls.ts';

/** What a held folder's entry is, as the host's `FileIdentity` spells it (`node-fs.ts` owns the type; this seam only fills it). */
export interface HeldIdentity {
  readonly kind: 'file' | 'directory' | 'link' | 'other';
  readonly device: bigint;
  readonly inode: bigint;
  readonly links: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly mode: number;
  readonly owner: number;
  readonly group: number;
}

/**
 * The steps on ONE held folder where no path reaches an open descriptor (macOS): every step goes through the folder's
 * descriptor and first PROVES the descriptor is still the folder it was opened on, by device and inode (copied from
 * today's `DescriptorBracket.proveHeld`: a descriptor number closed and reused by another folder would otherwise act
 * somewhere else). A parent swapped for a link after the check therefore changes nothing: the descriptor still names
 * the folder that was checked.
 */
export interface FolderSteps {
  /** The entry at `leaf`, never followed: `undefined` when nothing is there, a link as `kind: 'link'`. */
  identity(leaf: string): Promise<HeldIdentity | undefined>;
  /** A NEW file (`O_EXCL | O_NOFOLLOW`) with exactly `mode`, written and synced; what it is. Removes only what this call made on a failure. */
  writeNew(leaf: string, data: string | Uint8Array, mode: number): Promise<HeldIdentity>;
  /** Renames `leaf` to `toLeaf` in the folder `into`, which is proven the same way; replaces silently (the caller looks first). */
  renameInto(leaf: string, into: object, toLeaf: string): Promise<void>;
  /** A hard link to `leaf` named `toLeaf` in `into`; `EEXIST` when taken. */
  link(leaf: string, into: object, toLeaf: string): Promise<void>;
  /** Removes the non-folder `leaf`. */
  unlink(leaf: string): Promise<void>;
  /**
   * The folder `leaf`, opened from THIS folder's descriptor without following a link (`O_DIRECTORY | O_NOFOLLOW`): a
   * link there answers `ELOOP`, a file `ENOTDIR`, nothing `ENOENT`. Held in its own right; the caller closes it.
   */
  openFolder(leaf: string): Promise<HeldChild>;
  /**
   * The file `leaf`, opened for READING from THIS folder's descriptor without following a link or blocking
   * (`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`), after proving the descriptor is still the folder it was opened on. Throws the
   * errno's `code` (`ELOOP` for a link, `ENOENT` for nothing, `EACCES` for a file it may not read); the descriptor is
   * closed on every path that does not hand it out. Held in its own right; the caller closes it. Additive.
   */
  openFile(leaf: string): Promise<HeldFile>;
  /** Makes the folder `leaf` in THIS folder with `mode` (`mkdirat`; the umask filters it): `false` when it was already there (`EEXIST`). */
  makeFolder(leaf: string, mode: number): Promise<boolean>;
  /**
   * The steps a folder REMOVE needs, which only the working-directory bracket can take (a directory listing and
   * `rmdir` have no `openat` spelling): `undefined` when the host loaded the descriptor calls but not the bracket, and a
   * remove of a folder then refuses `no_descriptor_reach` as before.
   */
  readonly removal: FolderRemoval | undefined;
}

/** A child folder opened below a held one, held in its own right: its steps, what it is, and how to let go of it. */
export interface HeldChild {
  /** The child's open descriptor, for the host to wrap (it stays the folder it was opened on: see {@link HeldFolder}). */
  readonly fd: number;
  readonly identity: HeldIdentity;
  readonly steps: FolderSteps;
  close(): Promise<void>;
}

/** A file opened below a held folder, held in its own right: what it is and the reads that use ITS descriptor. */
export interface HeldFile {
  readonly identity: HeldIdentity;
  /** Up to `length` bytes starting at `position` (`pread`, through this descriptor); fewer at the end of the file. */
  readAt(position: number, length: number): Promise<Uint8Array>;
  /** The file's size now (`fstat` of this descriptor). */
  size(): Promise<number>;
  /** `fsync` of this descriptor. */
  sync(): Promise<void>;
  /** `fchmod` of this descriptor. */
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Removal on ONE held folder, every step through its descriptor and proven first (identity at the bracket as well as by
 * `fstat`). The recursion is by per-folder DESCRIPTORS (`openFolder`), never by a path rebuilt from names: a middle
 * folder swapped for a link is reached as the link (refused), never followed.
 */
export interface FolderRemoval {
  /** The entry at `leaf` itself (`lstat`, never followed): `undefined` when nothing is there. */
  lstat(leaf: string): Promise<HeldIdentity | undefined>;
  /** The names in the folder, sorted. */
  list(): Promise<readonly string[]>;
  /** Removes the EMPTY folder `leaf` (`rmdir`: a link there answers `ENOTDIR`, an entry inside `ENOTEMPTY`). */
  rmdir(leaf: string): Promise<void>;
  /** The folder `leaf`, opened without following a link (`O_DIRECTORY | O_NOFOLLOW`); throws the errno's `code` otherwise. */
  openFolder(leaf: string): Promise<HeldChild>;
}

/** What the removal steps need besides the descriptor calls: the bracket and the reading of its `lstat` answers. */
export interface RemovalSupport {
  readonly bracket: DescriptorBracket;
  readonly identityOfStats: (stats: BigIntStats) => HeldIdentity;
}

/** A folder held open by descriptor and what it was when it was opened (the seam's own view of a handle). */
export interface HeldFolder {
  readonly fd: number;
  readonly device: bigint;
  readonly inode: bigint;
}

const codeOf = (error: unknown): string | undefined => (error as { code?: string }).code;

const LOOK = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC;
/** The look for a file that only has write permission: the same open, for writing, still without truncating, blocking or following. */
const LOOK_WRITE = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC;
/** Errnos of an open that name an entry which is there (permission, a socket, a running program, a folder opened for writing). */
const PRESENT_BUT_NOT_OPENABLE: ReadonlySet<string> = new Set([
  'EACCES',
  'EPERM',
  'ENXIO',
  'EOPNOTSUPP',
  'ENOTSUP',
  'ETXTBSY',
  'EISDIR',
]);
const CREATE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC;

/** The descriptor calls of the runtime, as promises: nothing here blocks the loop on a slow disk (the C calls are one syscall each). */
const settle = (act: (done: (error: Error | null) => void) => void): Promise<void> =>
  new Promise((resolve, reject) => {
    act(error => (error === null ? resolve() : reject(error)));
  });

/** `fstat` of a descriptor, bigint. */
export const fstatOf = (fd: number): Promise<BigIntStats> =>
  new Promise((resolve, reject) => {
    fstat(fd, { bigint: true }, (error, stats) => (error === null ? resolve(stats) : reject(error)));
  });

const closeOf = (fd: number): Promise<void> => settle(done => close(fd, done));

/**
 * Runs the one synchronous create `make` under a process umask of `0o077`, restored in the same synchronous block.
 *
 * Why: on an Apple arm64 host the C call's variadic `mode` is read from a stack slot this binding does not fill, so a
 * created file can get ANY mode (see `descriptor-calls.ts`), and it is named in the folder from the moment `openat`
 * returns, until the `fchmod` that follows. A umask can only clear bits: under `0o077` whatever mode the kernel read
 * leaves at most the owner's bits, so no other user can open the file in that window. There is no `await` between the
 * set and the restore, so nothing else in this single-threaded process can create a file under the tighter umask, and
 * the restore runs when `make` throws too.
 */
function createOwnerOnly(make: () => number): number {
  const before = process.umask(0o077);
  try {
    return make();
  } finally {
    process.umask(before);
  }
}

/** The folder a step must reach, refused `EBADF` (as the kernel would) when the descriptor no longer names it. */
async function proveHeld(verb: string, ...folders: readonly HeldFolder[]): Promise<void> {
  for (const folder of folders) {
    const now = await fstatOf(folder.fd);
    if (now.dev !== folder.device || now.ino !== folder.inode) {
      throw Object.assign(
        new Error(`EBADF: refusing to ${verb}: a held folder is no longer the one it was opened on`),
        { code: 'EBADF' },
      );
    }
  }
}

/** Which held folder each handle the host gave out stands for, for the step that needs two of them. */
const held = new WeakMap<object, HeldFolder>();

/** Records that `handle` stands for `folder`. */
export const holdFolder = (handle: object, folder: HeldFolder): void => {
  held.set(handle, folder);
};

/** A child folder is opened with its own descriptor, never followed (a link answers `ELOOP`) and never a file (`ENOTDIR`). */
const FOLDER_OPEN = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC;

/** A name a removal step may be given: one plain segment (a NUL would end the C string early, `..` would leave the folder). */
const plainName = (verb: string, leaf: string): void => {
  if (!isSingleName(leaf)) {
    throw Object.assign(new Error(`EINVAL: refusing to ${verb}: that is not one plain name`), { code: 'EINVAL' });
  }
};

/** The removal steps on `folder`: each proves the descriptor still names it, then takes ONE bracket (see `descriptor-bracket.ts`). */
function removalSteps(
  calls: DescriptorCalls,
  folder: HeldFolder,
  identityOf: (fd: number) => Promise<HeldIdentity>,
  support: RemovalSupport,
): FolderRemoval {
  const step = async <T>(verb: string, act: Parameters<DescriptorBracket['run']>[2]): Promise<T> => {
    await proveHeld(verb, folder);
    return support.bracket.run(folder.fd, folder, act) as T;
  };
  return {
    lstat: async leaf => {
      plainName('look', leaf);
      const stats = await step<BigIntStats | undefined>('look', ops => ops.lstat(leaf));
      return stats === undefined ? undefined : support.identityOfStats(stats);
    },
    list: async () => await step<readonly string[]>('list', ops => ops.list()),
    rmdir: async leaf => {
      plainName('remove', leaf);
      await step<void>('remove', ops => {
        ops.rmdir(leaf);
      });
    },
    openFolder: async leaf => await openChild(calls, folder, identityOf, support, leaf),
  };
}

/** The folder `leaf` of `folder`, opened from its descriptor without following (see {@link FolderSteps.openFolder}). */
async function openChild(
  calls: DescriptorCalls,
  folder: HeldFolder,
  identityOf: (fd: number) => Promise<HeldIdentity>,
  support: RemovalSupport | undefined,
  leaf: string,
): Promise<HeldChild> {
  plainName('open', leaf);
  await proveHeld('open', folder);
  const fd = calls.openat(folder.fd, leaf, FOLDER_OPEN, 0);
  let identity: HeldIdentity;
  try {
    identity = await identityOf(fd);
  } catch (error) {
    await closeOf(fd).catch(() => undefined);
    throw error;
  }
  const child: HeldFolder = { fd, device: identity.device, inode: identity.inode };
  return { fd, identity, steps: folderSteps(calls, child, identityOf, support), close: async () => await closeOf(fd) };
}

/** The file `leaf` of `folder`, opened to read from its descriptor without following (see {@link FolderSteps.openFile}). */
async function openFileBelow(
  calls: DescriptorCalls,
  folder: HeldFolder,
  identityOf: (fd: number) => Promise<HeldIdentity>,
  leaf: string,
): Promise<HeldFile> {
  plainName('open', leaf);
  await proveHeld('open', folder);
  const fd = calls.openat(folder.fd, leaf, LOOK, 0);
  let identity: HeldIdentity;
  try {
    identity = await identityOf(fd);
  } catch (error) {
    await closeOf(fd).catch(() => undefined);
    throw error;
  }
  return {
    identity,
    readAt: async (position, length) => {
      const buffer = new Uint8Array(length);
      const count = await new Promise<number>((resolve, reject) => {
        readFd(fd, buffer, 0, length, position, (error, bytesRead) =>
          error === null ? resolve(bytesRead) : reject(error),
        );
      });
      return buffer.subarray(0, count);
    },
    size: async () => Number((await fstatOf(fd)).size),
    sync: async () => await settle(done => fsync(fd, done)),
    chmod: async mode => await settle(done => fchmod(fd, mode, done)),
    close: async () => await closeOf(fd),
  };
}

/**
 * The steps on `folder`, filled with `identityOf` (the host's reading of an `fstat` answer on a descriptor). `support`:
 * the working-directory bracket and what a folder REMOVE needs of it; without it `removal` is `undefined`.
 */
export function folderSteps(
  calls: DescriptorCalls,
  folder: HeldFolder,
  identityOf: (fd: number) => Promise<HeldIdentity>,
  support?: RemovalSupport,
): FolderSteps {
  const target = (verb: string, into: object): HeldFolder => {
    const other = held.get(into);
    if (other === undefined)
      throw Object.assign(new Error(`EBADF: refusing to ${verb}: that folder is not held`), { code: 'EBADF' });
    return other;
  };
  /**
   * One open of `leaf` just to read what it is: its identity, `undefined` when nothing is there, or the errno of an
   * entry that IS there but this open may not take (the answer today's `lstat` never needed an open to give).
   */
  const attempt = async (leaf: string, flags: number): Promise<HeldIdentity | undefined | string> => {
    let fd: number;
    try {
      fd = calls.openat(folder.fd, leaf, flags, 0);
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      // `O_NOFOLLOW` on a link: the leaf IS a link, and it was not opened (Linux and macOS answer ELOOP).
      if (code === 'ELOOP') return { ...EMPTY, kind: 'link' };
      if (code !== undefined && PRESENT_BUT_NOT_OPENABLE.has(code)) return code;
      throw error;
    }
    try {
      return await identityOf(fd);
    } finally {
      await closeOf(fd);
    }
  };
  /**
   * What is at `leaf`, never followed, as today's `lstat` answers it: an entry this process may not open for reading
   * (a mode-0 file, a folder without read permission, a socket) must still be SEEN. A write-only open reads the full
   * identity of a file that only has write permission; a folder answers `EISDIR` to it; anything else that is there but
   * cannot be opened is reported as `other` with no identity: the callers treat it as present, and a write that
   * needs its kind or mode refuses it (`outside`) rather than guess.
   */
  const look = async (leaf: string): Promise<HeldIdentity | undefined> => {
    await proveHeld('look', folder);
    const read = await attempt(leaf, LOOK);
    if (read !== 'EACCES') return typeof read === 'string' ? { ...EMPTY, kind: 'other' } : read;
    const write = await attempt(leaf, LOOK_WRITE);
    if (write === 'EISDIR') return { ...EMPTY, kind: 'directory' };
    return typeof write === 'string' ? { ...EMPTY, kind: 'other' } : write;
  };
  return {
    identity: look,
    writeNew: async (leaf, data, mode) => {
      await proveHeld('create', folder);
      const fd = createOwnerOnly(() => calls.openat(folder.fd, leaf, CREATE, mode));
      let created: HeldIdentity | undefined;
      let closed = false;
      try {
        created = await identityOf(fd);
        // exactly the asked bits, before any content: the mode `openat` was given is filtered by the umask (and on an
        // arm64 Mac is not read reliably at all: the create above ran under an owner-only umask, see `createOwnerOnly`)
        await settle(done => fchmod(fd, mode, done));
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        for (let written = 0; written < bytes.byteLength; )
          written += await new Promise<number>((resolve, reject) => {
            write(fd, bytes, written, bytes.byteLength - written, null, (error, count) =>
              error === null ? resolve(count) : reject(error),
            );
          });
        await settle(done => fsync(fd, done));
        closed = true;
        await closeOf(fd);
        return created;
      } catch (error) {
        if (!closed) await closeOf(fd).catch(() => undefined);
        // Only while the name still reaches the file this call created: a concurrent writer may have replaced it.
        const named = created === undefined ? undefined : await look(leaf).catch(() => undefined);
        if (created !== undefined && named?.device === created.device && named.inode === created.inode) {
          try {
            calls.unlinkat(folder.fd, leaf);
          } catch {
            // a cleanup never hides the failure that caused it
          }
        }
        throw error;
      }
    },
    renameInto: async (leaf, into, toLeaf) => {
      const other = target('rename', into);
      await proveHeld('rename', folder, other);
      calls.renameat(folder.fd, leaf, other.fd, toLeaf);
    },
    link: async (leaf, into, toLeaf) => {
      const other = target('link', into);
      await proveHeld('link', folder, other);
      calls.linkat(folder.fd, leaf, other.fd, toLeaf);
    },
    unlink: async leaf => {
      await proveHeld('unlink', folder);
      calls.unlinkat(folder.fd, leaf);
    },
    openFolder: async leaf => await openChild(calls, folder, identityOf, support, leaf),
    openFile: async leaf => await openFileBelow(calls, folder, identityOf, leaf),
    makeFolder: async (leaf, mode) => {
      plainName('make a folder', leaf);
      await proveHeld('make a folder', folder);
      try {
        calls.mkdirat(folder.fd, leaf, mode);
        return true;
      } catch (error) {
        if (codeOf(error) === 'EEXIST') return false;
        throw error;
      }
    },
    removal: support === undefined ? undefined : removalSteps(calls, folder, identityOf, support),
  };
}

const EMPTY: HeldIdentity = {
  kind: 'other',
  device: 0n,
  inode: 0n,
  links: 0,
  size: 0,
  mtimeMs: 0,
  mtimeNs: 0n,
  ctimeNs: 0n,
  mode: 0,
  owner: 0,
  group: 0,
};
