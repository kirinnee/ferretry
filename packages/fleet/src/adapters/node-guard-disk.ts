import { type BigIntStats, constants, createReadStream, existsSync, rmdirSync, unlinkSync } from 'node:fs';
import { access, type FileHandle, lstat, mkdir, open, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import type {
  FileIdentity,
  FolderDisk,
  GuardDirectoryHandle,
  GuardDisk,
  GuardReadHandle,
  GuardWriteHandle,
} from '../lib/state-home-guard.ts';

const COPY_CHUNK_BYTES = 64 * 1024;
// NONBLOCK on every write open too: a pipe put at the destination must not hang the daemon waiting for a reader.
const NEW_FILE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const EXISTING_FILE = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
const isMissing = (error: unknown): boolean => codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR';

function identityOf(entry: BigIntStats): FileIdentity {
  return {
    kind: entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
    device: entry.dev,
    inode: entry.ino,
    links: Number(entry.nlink),
    size: Number(entry.size),
    mode: Number(entry.mode & 0o7777n),
    owner: Number(entry.uid),
    group: Number(entry.gid),
  };
}

/** Too many bytes for what the caller allowed. */
export class GuardSizeError extends Error {
  constructor(maxBytes: number) {
    super(`that file is over the ${String(maxBytes)}-byte limit`);
    this.name = 'GuardSizeError';
  }
}

/** Reads `handle` from its start in chunks, handing each to `sink`; throws past `maxBytes`. */
async function drain(
  handle: FileHandle,
  maxBytes: number,
  sink: (chunk: Uint8Array) => Promise<void>,
): Promise<number> {
  const buffer = new Uint8Array(COPY_CHUNK_BYTES);
  let total = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
    if (bytesRead === 0) return total;
    total += bytesRead;
    if (total > maxBytes) throw new GuardSizeError(maxBytes);
    await sink(buffer.slice(0, bytesRead));
  }
}

/** Opens `path` and reads what the descriptor says it is; the descriptor is closed if that fails. */
async function opened(path: string, flags: number, mode?: number): Promise<[FileHandle, FileIdentity]> {
  const handle = await open(path, flags, mode);
  let identity: FileIdentity | undefined;
  try {
    identity = identityOf(await handle.stat({ bigint: true }));
    return [handle, identity];
  } finally {
    if (identity === undefined) await handle.close();
  }
}

/**
 * The state-home guard's disk, over Node. Every open refuses a link at its last step (`O_NOFOLLOW`); a new
 * file is `O_EXCL`; a read never blocks on a pipe. On Linux an open folder's entries are reached through
 * `/proc/self/fd/N/<leaf>`, so a folder swapped after it was checked is never written into.
 */
export class NodeGuardDisk implements GuardDisk, FolderDisk {
  /**
   * Asked for descriptor paths, but this host has no `descriptorFolder` (a container or sandbox without `/proc`).
   * Entries are then reached by path, re-proved before each step, and a caller that needs descriptor paths to
   * act safely can refuse loudly instead of acting on folders that read as empty.
   */
  readonly missingDescriptorPaths: boolean;
  private readonly throughDescriptors: boolean;

  /**
   * `throughDescriptors`: reach a folder's entries through its open descriptor (Linux `/proc`). `groupDatabase`:
   * the group file read for this user's listed groups — a test names another. `descriptorFolder`: where an open
   * descriptor is reached by number — a test names one that is not there.
   */
  constructor(
    throughDescriptors: boolean = process.platform === 'linux',
    private readonly groupDatabase: string = '/etc/group',
    private readonly descriptorFolder: string = '/proc/self/fd',
  ) {
    this.missingDescriptorPaths = throughDescriptors && !existsSync(descriptorFolder);
    this.throughDescriptors = throughDescriptors && !this.missingDescriptorPaths;
  }

  async realpath(path: string): Promise<string> {
    return await realpath(path);
  }

  async identity(path: string): Promise<FileIdentity | undefined> {
    try {
      return identityOf(await lstat(path, { bigint: true }));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async openRead(path: string): Promise<GuardReadHandle> {
    const [handle, identity] = await opened(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return {
      identity,
      copyTo: async (to, maxBytes, mode) => {
        const target = await open(to, NEW_FILE, mode);
        try {
          return await drain(handle, maxBytes, async chunk => {
            await target.write(chunk);
          });
        } finally {
          await target.close();
        }
      },
      readText: async maxBytes => {
        const chunks: Uint8Array[] = [];
        await drain(handle, maxBytes, async chunk => {
          chunks.push(chunk);
        });
        return Buffer.concat(chunks).toString('utf8');
      },
      close: async () => await handle.close(),
    };
  }

  async openDirectory(path: string): Promise<GuardDirectoryHandle> {
    const [handle, identity] = await opened(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    return {
      identity,
      entryPath: leaf =>
        this.throughDescriptors ? `${this.descriptorFolder}/${String(handle.fd)}/${leaf}` : undefined,
      chmod: async mode => await handle.chmod(mode),
      close: async () => await handle.close(),
    };
  }

  async openWrite(path: string, how: 'new' | 'existing', mode: number): Promise<GuardWriteHandle | 'taken' | 'absent'> {
    let handle: FileHandle;
    let identity: FileIdentity;
    try {
      [handle, identity] = await opened(path, how === 'new' ? NEW_FILE : EXISTING_FILE, mode);
    } catch (error) {
      if (how === 'new' && codeOf(error) === 'EEXIST') return 'taken';
      if (how === 'existing' && codeOf(error) === 'ENOENT') return 'absent';
      throw error;
    }
    return {
      identity,
      truncate: async () => await handle.truncate(0),
      copyFrom: async (source, maxBytes) => {
        let written = 0;
        for await (const chunk of createReadStream(source)) {
          const bytes = chunk as Uint8Array;
          written += bytes.byteLength;
          if (written > maxBytes) throw new GuardSizeError(maxBytes);
          await handle.write(bytes, 0, bytes.byteLength, written - bytes.byteLength);
        }
        return written;
      },
      close: async () => await handle.close(),
    };
  }

  async readlink(path: string): Promise<string> {
    return await readlink(path);
  }

  async list(path: string): Promise<readonly string[]> {
    return await readdir(path);
  }

  async mkdir(path: string, mode: number): Promise<void> {
    await mkdir(path, { mode });
  }

  // Synchronous, like a guarded removal's every step: one cheap call each, and a tree is removed one name at a
  // time (`removeEntryWithin`), where Bun's per-call cost of the asynchronous form made a skills tree slow.
  async unlink(path: string): Promise<void> {
    unlinkSync(path);
  }

  async rmdir(path: string): Promise<void> {
    rmdirSync(path);
  }

  async groups(): Promise<readonly number[]> {
    const live = [...(process.getgroups?.() ?? []), ...(process.getegid === undefined ? [] : [process.getegid()])];
    return [...new Set([...live, ...(await listedGroups(this.groupDatabase, userInfo().username))])];
  }

  async writable(path: string): Promise<boolean> {
    try {
      await access(path, constants.W_OK);
      return true;
    } catch (error) {
      if (codeOf(error) === 'EACCES' || codeOf(error) === 'EPERM' || codeOf(error) === 'EROFS') return false;
      throw error;
    }
  }
}

/**
 * The groups the group file lists `user` in: a listed member may join one with `sg` without a password, so it
 * counts as this process's even before the process holds it. Where the file is absent (macOS keeps groups in its
 * directory service) only the live groups count, and `access(W_OK)` remains the check that does not guess. Any
 * OTHER failure to read it throws: a proof that cannot see the group list must not conclude the store is closed.
 */
async function listedGroups(database: string, user: string): Promise<readonly number[]> {
  const text = await readFile(database, 'utf8').catch((error: unknown) => {
    if (codeOf(error) === 'ENOENT') return '';
    throw error;
  });
  return text.split('\n').flatMap(line => {
    const [, , gid, members] = line.split(':');
    const id = Number(gid);
    return Number.isInteger(id) && (members ?? '').split(',').includes(user) ? [id] : [];
  });
}
