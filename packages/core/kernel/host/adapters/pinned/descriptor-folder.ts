import { type BigIntStats, close, constants, fchmod, fstat, fsync, write } from 'node:fs';
import { type DescriptorCalls, O_CLOEXEC } from './descriptor-calls.ts';

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
}

/** A folder held open by descriptor and what it was when it was opened (the seam's own view of a handle). */
export interface HeldFolder {
  readonly fd: number;
  readonly device: bigint;
  readonly inode: bigint;
}

const codeOf = (error: unknown): string | undefined => (error as { code?: string }).code;

const LOOK = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC;
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

/** The steps on `folder`, filled with `identityOf` (the host's reading of an `fstat` answer on a descriptor). */
export function folderSteps(
  calls: DescriptorCalls,
  folder: HeldFolder,
  identityOf: (fd: number) => Promise<HeldIdentity>,
): FolderSteps {
  const target = (verb: string, into: object): HeldFolder => {
    const other = held.get(into);
    if (other === undefined)
      throw Object.assign(new Error(`EBADF: refusing to ${verb}: that folder is not held`), { code: 'EBADF' });
    return other;
  };
  const look = async (leaf: string): Promise<HeldIdentity | undefined> => {
    await proveHeld('look', folder);
    let fd: number;
    try {
      fd = calls.openat(folder.fd, leaf, LOOK, 0);
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      // `O_NOFOLLOW` on a link: the leaf IS a link, and it was not opened (Linux and macOS answer ELOOP).
      if (code === 'ELOOP') return { ...EMPTY, kind: 'link' };
      throw error;
    }
    try {
      return await identityOf(fd);
    } finally {
      await closeOf(fd);
    }
  };
  return {
    identity: look,
    writeNew: async (leaf, data, mode) => {
      await proveHeld('create', folder);
      const fd = calls.openat(folder.fd, leaf, CREATE, mode);
      let created: HeldIdentity | undefined;
      let closed = false;
      try {
        created = await identityOf(fd);
        // exactly the asked bits, before any content: the mode `openat` was given is filtered by the umask (and on an
        // arm64 Mac is not read reliably at all, see `descriptor-calls.ts`)
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
