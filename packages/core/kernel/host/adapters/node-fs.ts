import { type BigIntStats, constants, fchmod, fsync } from 'node:fs';
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
import { type DescriptorBracket, loadProcessBracket } from './pinned/descriptor-bracket.ts';
import { type DescriptorCalls, isSingleName, loadDescriptorCalls } from './pinned/descriptor-calls.ts';
import {
  type FolderSteps,
  folderSteps,
  fstatOf,
  type HeldChild,
  type HeldFile,
  holdFolder,
} from './pinned/descriptor-folder.ts';

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
  /** The modification time to the nanosecond: a whole-millisecond compare misses a change made in the same millisecond. */
  readonly mtimeNs: bigint;
  /** The status-change time to the nanosecond: it moves on every create, rename and remove in a folder, and cannot be set back. */
  readonly ctimeNs: bigint;
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
  /** Sets this file's permission bits through the descriptor (`fchmod`), never by name (`RootHandle.setMode`). */
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

/** A folder opened (`O_DIRECTORY | O_NOFOLLOW`) so its entries are reached THROUGH it. */
export interface OpenedDirectory {
  readonly identity: FileIdentity;
  /** A path that reaches `leaf` in this open folder (Linux `/proc/self/fd/N/leaf`), or `undefined` where there is none. */
  entryPath(leaf: string): string | undefined;
  /**
   * Where `entryPath` has no path (macOS) but the host loaded the C library's descriptor calls: the steps a write
   * and a rename need, each through THIS open folder and proven against its device and inode first. `undefined` on a
   * host with `/proc/self/fd` (it uses `entryPath`) and on one whose calls could not be loaded: there a rename and a
   * folder remove refuse `no_descriptor_reach`, while a write and a publish re-prove the folder once and go by path
   * (as `roots.ts` says). A remove goes through `at.removal` (the working-directory bracket) when it loaded too.
   * Additive.
   */
  readonly at?: FolderSteps;
  /**
   * The folder `leaf` BELOW this one, opened from this folder's descriptor and never by a path that a link could
   * redirect: `O_DIRECTORY | O_NOFOLLOW` through `entryPath` (Linux) or through `at` (macOS). With `make` a missing
   * folder is made first the same way (`mkdir` through the descriptor, mode as given) and `created` says whether THIS
   * call made it. Throws the errno's `code` (`ELOOP` for a link, `ENOTDIR` for a file, `ENOENT` for nothing, without
   * `make`); a host with neither a descriptor path nor the C library's calls throws `ENOSYS`. The caller closes
   * the returned folder, and this one stays open.
   */
  openChild(
    leaf: string,
    make?: { readonly mode: number },
  ): Promise<{ readonly folder: OpenedDirectory; readonly created: boolean }>;
  /**
   * The file `leaf` BELOW this folder, opened to read from this folder's descriptor and never by a path a link could
   * redirect: `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` through `entryPath` (Linux) or through `at` (macOS), after the
   * folder is proven to still be the one it was opened on. Throws the errno's `code` (`ELOOP` for a link, `ENOENT` for
   * nothing, `EACCES` for a file it may not read); a host with neither a descriptor path nor the C library's calls
   * throws `ENOSYS`. The caller closes the returned file. Additive.
   */
  openFile(leaf: string): Promise<OpenedFile>;
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
  /**
   * How this host reaches an open folder, asked once at boot so the doctor can say what a host without it gives up:
   * `path` (a descriptor is a path, Linux `/proc/self/fd`), `calls` (the C library's descriptor calls loaded) and
   * `bracket` (the working-directory bracket a listing and a remove go through, loaded). Only the real disk answers.
   */
  descriptorReach?(): Promise<{ readonly path: boolean; readonly calls: boolean; readonly bracket: boolean }>;
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
    mtimeNs: entry.mtimeNs,
    ctimeNs: entry.ctimeNs,
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
    if (identity === undefined) {
      const made = await handle.stat({ bigint: true }).catch(() => undefined);
      await handle.close().catch(() => undefined);
      // An exclusive create made this name, so a file this call cannot describe is one only this call can remove.
      if ((flags & constants.O_EXCL) !== 0) {
        // Only while the name still reaches what this call opened: another writer may have replaced it since.
        const named = await lstat(path, { bigint: true }).catch(() => undefined);
        if (named !== undefined && made !== undefined && named.dev === made.dev && named.ino === made.ino)
          await unlink(path).catch(() => undefined);
      }
    }
  }
}

/** Reads `handle` from its start, at most `limit` bytes. */
async function readAll(handle: FileHandle, limit: number | undefined): Promise<Uint8Array> {
  return await readChunks(async (position, length) => {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  }, limit);
}

/** The reads of {@link readAll} over any positional read (a file held below a folder reads through its own descriptor). */
async function readChunks(
  readAt: (position: number, length: number) => Promise<Uint8Array>,
  limit: number | undefined,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const want = limit === undefined ? READ_CHUNK_BYTES : Math.min(READ_CHUNK_BYTES, limit - total);
    if (want <= 0) break;
    const chunk = await readAt(total, want);
    if (chunk.byteLength === 0) break;
    chunks.push(chunk);
    total += chunk.byteLength;
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
 * entries by their real path, re-proved before each step; a folder remove is refused there, and so is any remove of an
 * owner root.
 */
export function nodeFs(
  randomSuffix: () => string,
  options: {
    readonly descriptorFolder?: string;
    readonly groupDatabase?: string;
    /**
     * Where a host without `descriptorFolder` gets the C library's descriptor calls (`openat`, `renameat`, `linkat`,
     * `unlinkat`): asked once, on the first folder opened, and a throw means none (a rename and a folder remove then
     * refuse `no_descriptor_reach`, and so does every `project-files` write; a write or a publish in any other root re-proves the folder once and goes by path). Default: loaded from the platform's C library on macOS, none elsewhere.
     */
    readonly descriptorCalls?: () => DescriptorCalls;
    /**
     * Where a host without `descriptorFolder` gets the working-directory bracket a folder remove goes through: asked
     * once, with the calls, and a throw means none (a folder remove then refuses `no_descriptor_reach`). Default: the
     * process's one bracket on macOS, none elsewhere.
     */
    readonly bracket?: () => DescriptorBracket;
  } = {},
): HostFs {
  const loadCalls =
    options.descriptorCalls ?? (process.platform === 'darwin' ? () => loadDescriptorCalls() : undefined);
  let calls: DescriptorCalls | undefined;
  let tried = false;
  const callsOrNone = (): DescriptorCalls | undefined => {
    if (!tried) {
      tried = true;
      try {
        calls = loadCalls?.();
      } catch {
        calls = undefined;
      }
    }
    return calls;
  };
  const loadBracket = options.bracket ?? (process.platform === 'darwin' ? loadProcessBracket : undefined);
  let bracket: DescriptorBracket | undefined;
  let bracketTried = false;
  const bracketOrNone = (): DescriptorBracket | undefined => {
    if (!bracketTried) {
      bracketTried = true;
      try {
        bracket = loadBracket?.();
      } catch {
        bracket = undefined;
      }
    }
    return bracket;
  };
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
  const noReach = (): Error =>
    Object.assign(new Error('ENOSYS: this host reaches no folder through a held folder'), { code: 'ENOSYS' });
  const openReadAt = async (path: string): Promise<OpenedFile> => {
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
      chmod: async mode => await handle.chmod(mode),
      close: async () => await handle.close(),
    };
  };
  /** A file opened by `steps` (no path reaches it): the same `OpenedFile` over its own descriptor. */
  const heldFile = (file: HeldFile): OpenedFile => ({
    identity: file.identity,
    read: async limit => await readChunks(file.readAt, limit),
    readWindow: async (offset, length) => {
      const size = await file.size();
      const from = offset < 0 ? Math.max(0, size + offset) : offset;
      const wanted = Math.max(0, Math.min(length, size - from));
      return { bytes: wanted === 0 ? new Uint8Array(0) : await file.readAt(from, wanted), size };
    },
    sync: async () => await file.sync(),
    chmod: async mode => await file.chmod(mode),
    close: async () => await file.close(),
  });
  /** `leaf` of a macOS held folder: made (`mkdirat`) when asked, then opened from its descriptor without following. */
  const childThroughSteps = async (
    steps: FolderSteps,
    leaf: string,
    make: { readonly mode: number } | undefined,
  ): Promise<{ readonly folder: OpenedDirectory; readonly created: boolean }> => {
    const created = make === undefined ? false : await steps.makeFolder(leaf, make.mode);
    return { folder: heldDirectory(await steps.openFolder(leaf)), created };
  };
  /** A folder opened by `steps` (no path reaches it): the same `OpenedDirectory` over its own descriptor. */
  const heldDirectory = (child: HeldChild): OpenedDirectory => {
    const directory: OpenedDirectory = {
      identity: child.identity,
      entryPath: () => undefined,
      at: child.steps,
      openChild: async (leaf, make) => await childThroughSteps(child.steps, leaf, make),
      openFile: async leaf => heldFile(await child.steps.openFile(leaf)),
      chmod: async mode =>
        await new Promise<void>((resolve, reject) => {
          fchmod(child.fd, mode, error => (error === null ? resolve() : reject(error)));
        }),
      sync: async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            fsync(child.fd, error => (error === null ? resolve() : reject(error)));
          });
        } catch (error) {
          if (!unsupportedDirectorySync(error)) throw error;
        }
      },
      close: async () => await child.close(),
    };
    holdFolder(directory, { fd: child.fd, device: child.identity.device, inode: child.identity.inode });
    return directory;
  };
  const openDirectory = async (path: string): Promise<OpenedDirectory> => {
    const reached = await throughDescriptors();
    const [handle, identity] = await opened(path, READ_DIRECTORY);
    const descriptorCalls = reached ? undefined : callsOrNone();
    const workingDirectory = descriptorCalls === undefined ? undefined : bracketOrNone();
    const at =
      descriptorCalls === undefined
        ? undefined
        : folderSteps(
            descriptorCalls,
            { fd: handle.fd, device: identity.device, inode: identity.inode },
            async fd => fileIdentityOf(await fstatOf(fd)),
            workingDirectory === undefined ? undefined : { bracket: workingDirectory, identityOfStats: fileIdentityOf },
          );
    const directory: OpenedDirectory = {
      identity,
      entryPath: leaf => (reached ? `${descriptorFolder}/${String(handle.fd)}/${leaf}` : undefined),
      at,
      openChild: async (leaf, make) => {
        if (!isSingleName(leaf))
          throw Object.assign(new Error('EINVAL: that is not one plain name'), { code: 'EINVAL' });
        if (!reached) {
          if (at === undefined) throw noReach();
          return await childThroughSteps(at, leaf, make);
        }
        // This descriptor must still be the folder it was opened on before its number is used as a path.
        const now = await handle.stat({ bigint: true });
        if (now.dev !== identity.device || now.ino !== identity.inode)
          throw Object.assign(new Error('EBADF: a held folder is no longer the one it was opened on'), {
            code: 'EBADF',
          });
        const through = `${descriptorFolder}/${String(handle.fd)}/${leaf}`;
        let created = false;
        if (make !== undefined) {
          try {
            await mkdir(through, { mode: make.mode });
            created = true;
          } catch (error) {
            if (codeOf(error) !== 'EEXIST') throw error;
          }
        }
        return { folder: await openDirectory(through), created };
      },
      openFile: async leaf => {
        if (!isSingleName(leaf))
          throw Object.assign(new Error('EINVAL: that is not one plain name'), { code: 'EINVAL' });
        if (!reached) {
          if (at === undefined) throw noReach();
          return heldFile(await at.openFile(leaf));
        }
        // This descriptor must still be the folder it was opened on before its number is used as a path.
        const now = await handle.stat({ bigint: true });
        if (now.dev !== identity.device || now.ino !== identity.inode)
          throw Object.assign(new Error('EBADF: a held folder is no longer the one it was opened on'), {
            code: 'EBADF',
          });
        return await openReadAt(`${descriptorFolder}/${String(handle.fd)}/${leaf}`);
      },
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
    holdFolder(directory, { fd: handle.fd, device: identity.device, inode: identity.inode });
    return directory;
  };
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
    openRead: openReadAt,
    openDirectory,
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
        // Only while the name still reaches the file this call created: a concurrent replacing write may have
        // renamed its own file over it, and that one belongs to its publisher.
        const named = await lstat(path, { bigint: true }).catch(() => undefined);
        if (named !== undefined && named.dev === identity.device && named.ino === identity.inode)
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
    descriptorReach: async () => ({
      path: await throughDescriptors(),
      calls: callsOrNone() !== undefined,
      bracket: bracketOrNone() !== undefined,
    }),
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
