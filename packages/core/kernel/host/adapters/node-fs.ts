import { type BigIntStats, constants } from 'node:fs';
import {
  access,
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';

/**
 * Which entry a path names: what kind, and the device and inode that name it whatever path reached it (copied from
 * today's state-home guard, `FileIdentity`).
 */
export interface FileIdentity {
  readonly kind: 'file' | 'directory' | 'link' | 'other';
  readonly device: bigint;
  readonly inode: bigint;
  /** How many names (hard links) the file has. */
  readonly links: number;
  readonly size: number;
  readonly mtimeMs: number;
  /** The permission bits. */
  readonly mode: number;
  readonly owner: number;
  readonly group: number;
}

/** A file opened once to read (`O_NOFOLLOW | O_NONBLOCK`): what it is, and the reads that use THIS descriptor. */
export interface OpenedFile {
  readonly identity: FileIdentity;
  /** At most `limit` bytes from the start, read through this descriptor. */
  read(limit?: number): Promise<Uint8Array>;
  /**
   * `length` bytes from `offset` (`offset` < 0 counts back from the end) and the file's size, through this
   * descriptor.
   */
  readWindow(offset: number, length: number): Promise<{ readonly bytes: Uint8Array; readonly size: number }>;
  /** `fsync` of THIS descriptor: what was read from it is on the disk, not only in the page cache. */
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** A folder opened (`O_DIRECTORY | O_NOFOLLOW`) so its entries are reached THROUGH it. */
export interface OpenedDirectory {
  readonly identity: FileIdentity;
  /** A path that reaches `leaf` in this open folder (Linux `/proc/self/fd/N/leaf`), or `undefined` where there is none. */
  entryPath(leaf: string): string | undefined;
  /** Sets this folder's permission bits through the descriptor (`fchmod`), never by name. */
  chmod(mode: number): Promise<void>;
  /**
   * `fsync` of THIS folder's entries, through the descriptor that was proven to be the folder (never by name).
   * Tolerates exactly the three errnos a filesystem that cannot sync a directory answers (`EINVAL`, `ENOTSUP`,
   * `EPERM`, as the state filesystem does); every other failure propagates, because a directory entry that could not
   * be made durable for any other reason is not durable.
   */
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The kernel's filesystem seam: the only place `node:fs` is used by the host (§7.7 `banned-globals`). */
export interface HostFs {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<
    | {
        readonly kind: 'file' | 'directory' | 'link' | 'other';
        readonly size: number;
        readonly mtimeMs: number;
        /** Hard links to the object; a file with more than one may be a file from anywhere and is never copied. */
        readonly links?: number;
        /** POSIX permission bits. */
        readonly mode?: number;
      }
    | undefined
  >;
  /** The entry itself (`lstat`), never followed; `undefined` when nothing is there. */
  identity(path: string): Promise<FileIdentity | undefined>;
  /** Opens to read without following a link at the last step and without blocking on a pipe. */
  openRead(path: string): Promise<OpenedFile>;
  /** Opens a folder without following a link at the last step. */
  openDirectory(path: string): Promise<OpenedDirectory>;
  /**
   * Creates a NEW file (`O_EXCL | O_NOFOLLOW | O_NONBLOCK`) with exactly `mode` (not filtered by the umask), writes
   * `data`, syncs it; answers what was created.
   */
  writeNew(path: string, data: string | Uint8Array, mode: number): Promise<FileIdentity>;
  /**
   * A hard link at `destination` to the file at `existing`, refused with `EEXIST` when anything is already at
   * `destination` (`link(2)`: create-if-absent in the kernel, atomically). Neither end is followed.
   */
  link(existing: string, destination: string): Promise<void>;
  /** Makes ONE folder (no parents). */
  mkdir(path: string, mode: number): Promise<void>;
  /** A link at `path` whose text is `target`; refused when anything is already there. */
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** Atomic: a temp file in the same folder, fsync, rename. For the daemon's own files only, never a root. */
  writeAtomic(path: string, data: string | Uint8Array, mode?: number): Promise<void>;
  list(path: string): Promise<readonly string[]>;
  remove(path: string): Promise<void>;
  mkdirp(path: string, mode?: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /**
   * This process's group ids as they stand NOW — its supplementary groups, its effective group, and every group the
   * group database lists it in. Read here, never handed in by a caller.
   */
  groups(): Promise<readonly number[]>;
  /** Whether this process may write in `path` (`access(W_OK)`). */
  writable(path: string): Promise<boolean>;
}

const codeOf = (error: unknown): string | undefined => (error as { code?: string }).code;
const isMissing = (error: unknown): boolean => codeOf(error) === 'ENOENT';
const isGone = (error: unknown): boolean => codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR';

/** Whether an error means this filesystem cannot sync a directory at all (the three the state filesystem tolerates). */
const unsupportedDirectorySync = (error: unknown): boolean =>
  codeOf(error) === 'EINVAL' || codeOf(error) === 'ENOTSUP' || codeOf(error) === 'EPERM';

// NONBLOCK on every open: a pipe put where a file was must not hang the daemon waiting for a writer or reader.
const READ_FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const NEW_FILE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const READ_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ_CHUNK_BYTES = 64 * 1024;

/** The identity of an entry the runtime described (`lstat`/`fstat`, bigint). */
function fileIdentityOf(entry: BigIntStats): FileIdentity {
  return {
    kind: entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
    device: entry.dev,
    inode: entry.ino,
    links: Number(entry.nlink),
    size: Number(entry.size),
    mtimeMs: Number(entry.mtimeMs),
    mode: Number(entry.mode & 0o7777n),
    owner: Number(entry.uid),
    group: Number(entry.gid),
  };
}

/** Opens `path` and reads what the descriptor says it is; the descriptor is closed if that fails. */
async function opened(path: string, flags: number, mode?: number): Promise<[FileHandle, FileIdentity]> {
  const handle = await open(path, flags, mode);
  let identity: FileIdentity | undefined;
  try {
    identity = fileIdentityOf(await handle.stat({ bigint: true }));
    return [handle, identity];
  } finally {
    if (identity === undefined) await handle.close();
  }
}

/** Reads `handle` from its start, at most `limit` bytes. */
async function readAll(handle: FileHandle, limit: number | undefined): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const want = limit === undefined ? READ_CHUNK_BYTES : Math.min(READ_CHUNK_BYTES, limit - total);
    if (want <= 0) break;
    const buffer = new Uint8Array(want);
    const { bytesRead } = await handle.read(buffer, 0, want, total);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * The groups the group file lists `user` in: a listed member may join one with `sg` without a password, so it counts
 * as this process's. Where the file is absent only the live groups count. Any OTHER failure to read it throws.
 */
async function listedGroups(database: string, user: string): Promise<readonly number[]> {
  const text = await readFile(database, 'utf8').catch((error: unknown) => {
    if (isMissing(error)) return '';
    throw error;
  });
  return text.split('\n').flatMap(line => {
    const [, , gid, members] = line.split(':');
    const id = Number(gid);
    return Number.isInteger(id) && (members ?? '').split(',').includes(user) ? [id] : [];
  });
}

/**
 * `descriptorFolder`: where an open descriptor is reached by number (Linux `/proc/self/fd`); a host without it reaches
 * entries by their real path, re-proved before each step, and a remove or move outside daemon folders is refused.
 */
export function nodeFs(
  randomSuffix: () => string,
  options: { readonly descriptorFolder?: string; readonly groupDatabase?: string } = {},
): HostFs {
  const descriptorFolder =
    options.descriptorFolder ?? (process.platform === 'linux' ? '/proc/self/fd' : '/nonexistent-descriptor-folder');
  // Asked once, without blocking: whether this host reaches an open descriptor by number.
  let reach: Promise<boolean> | undefined;
  const throughDescriptors = (): Promise<boolean> =>
    (reach ??= access(descriptorFolder).then(
      () => true,
      () => false,
    ));
  const groupDatabase = options.groupDatabase ?? '/etc/group';
  return {
    realpath: path => realpath(path),
    lstat: async path => {
      try {
        const info = await lstat(path);
        const kind = info.isSymbolicLink()
          ? 'link'
          : info.isDirectory()
            ? 'directory'
            : info.isFile()
              ? 'file'
              : 'other';
        return { kind, size: info.size, mtimeMs: info.mtimeMs, links: info.nlink, mode: info.mode & 0o7777 };
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    identity: async path => {
      try {
        return fileIdentityOf(await lstat(path, { bigint: true }));
      } catch (error) {
        if (isGone(error)) return undefined;
        throw error;
      }
    },
    openRead: async path => {
      const [handle, identity] = await opened(path, READ_FILE);
      return {
        identity,
        read: async limit => await readAll(handle, limit),
        readWindow: async (offset, length) => {
          const size = Number((await handle.stat({ bigint: true })).size);
          const from = offset < 0 ? Math.max(0, size + offset) : offset;
          const buffer = new Uint8Array(Math.max(0, Math.min(length, size - from)));
          const { bytesRead } =
            buffer.length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, buffer.length, from);
          return { bytes: buffer.subarray(0, bytesRead), size };
        },
        sync: async () => await handle.sync(),
        close: async () => await handle.close(),
      };
    },
    openDirectory: async path => {
      const reached = await throughDescriptors();
      const [handle, identity] = await opened(path, READ_DIRECTORY);
      return {
        identity,
        entryPath: leaf => (reached ? `${descriptorFolder}/${String(handle.fd)}/${leaf}` : undefined),
        chmod: async mode => await handle.chmod(mode),
        sync: async () => {
          try {
            await handle.sync();
          } catch (error) {
            if (!unsupportedDirectorySync(error)) throw error;
          }
        },
        close: async () => await handle.close(),
      };
    },
    writeNew: async (path, data, mode) => {
      const [handle, identity] = await opened(path, NEW_FILE, mode);
      try {
        // exactly the asked bits: the mode `open` was given is filtered by the umask
        await handle.chmod(mode);
        await handle.writeFile(data);
        await handle.sync();
      } catch (error) {
        // The exclusive create above is what made this name ours, so a failure after it leaves a partial private
        // file that only this call can remove. A create that LOST (EEXIST) never reaches here and removes nothing.
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
      }
      await handle.close();
      return identity;
    },
    link: async (existing, destination) => {
      await link(existing, destination);
    },
    mkdir: async (path, mode) => {
      await mkdir(path, { mode });
    },
    readlink: path => readlink(path),
    unlink: path => unlink(path),
    rmdir: path => rmdir(path),
    readText: path => readFile(path, 'utf8'),
    readBytes: async path => new Uint8Array(await readFile(path)),
    writeAtomic: async (path, data, mode = 0o600) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${randomSuffix()}.tmp`;
      const handle = await open(temp, 'wx', mode);
      try {
        // exactly the asked bits: the mode `open` was given is filtered by the umask
        await handle.chmod(mode);
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, path);
    },
    symlink: async (target, path) => {
      await symlink(target, path);
    },
    list: async path => {
      try {
        return (await readdir(path)).sort();
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    },
    remove: path => rm(path, { recursive: true, force: true }),
    mkdirp: async (path, mode = 0o700) => {
      await mkdir(path, { recursive: true, mode });
    },
    chmod: (path, mode) => chmod(path, mode),
    rename: (from, to) => rename(from, to),
    groups: async () => {
      const live = [...(process.getgroups?.() ?? []), ...(process.getegid === undefined ? [] : [process.getegid()])];
      return [...new Set([...live, ...(await listedGroups(groupDatabase, userInfo().username))])];
    },
    writable: async path => {
      try {
        await access(path, constants.W_OK);
        return true;
      } catch (error) {
        const code = codeOf(error);
        if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return false;
        throw error;
      }
    },
  };
}
