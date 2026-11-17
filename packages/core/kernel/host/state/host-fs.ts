import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { AtomicFileWriter } from './atomic-file.ts';
import type { FileOperations, TempNameSource } from './file-operations.ts';
import { NodeFileOperations, RandomTempNameSource } from './file-operations.ts';

/** What the host knows about one path, never following a link. */
export interface HostFileInfo {
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly inode: number;
  /** An ordinary file: not a link, a directory or a device. */
  readonly regularFile: boolean;
  readonly directory: boolean;
  readonly symlink?: boolean;
  /** The device the file lives on. Absent where the host has no such thing (the in-memory host). */
  readonly device?: bigint;
  /**
   * The status-change time to the nanosecond. Every write, rename and truncate moves it and no caller can set it back
   * (`utimes` sets the modification time, never this), so unlike {@link modifiedAtMs} it cannot be forged. Absent
   * where the host has no such clock.
   */
  readonly changedAtNs?: bigint;
}

export interface HostDirEntry {
  readonly name: string;
  readonly directory: boolean;
  /** An ordinary file; a link is neither a file nor a directory here. */
  readonly regularFile: boolean;
}

/**
 * The whole filesystem surface the state store and the config files may use (absolute paths only). Narrow on
 * purpose: it is injected, so a test runs on memory and a fault test breaks any one step, and nothing else about
 * the host is reachable. A link is never followed by any call.
 */
export interface HostFs {
  /** The file's text, or `undefined` when it does not exist. A link, or any other fault, throws. */
  readText(path: string): Promise<string | undefined>;
  readBytes(path: string): Promise<Uint8Array | undefined>;
  /**
   * At most the last `maxBytes` of a regular file and the offset they start at; `undefined` when it does not exist.
   * A link is refused, never followed.
   */
  readTail(path: string, maxBytes: number): Promise<{ readonly bytes: Uint8Array; readonly from: number } | undefined>;
  /**
   * Hands a regular file to `onChunk` in pieces of at most `chunkBytes`, in order, holding only one piece: `false`
   * when the file does not exist. A piece is reused after `onChunk` returns, so it must be copied to be kept. A
   * link is refused, never followed; a fault, or a throw from `onChunk`, ends the read and rejects.
   *
   * A piece ends on a newline: a line is never handed over in two parts, so a writer that rewrites the end of the file
   * between two reads (an append cuts a crash's torn last line off first) can never be glued onto what was already
   * read. A piece grows past `chunkBytes`, up to `maxLineBytes`, to hold one whole line. Only a line longer than
   * that, and the file's last line when it has no newline (handed over once the end of the file is confirmed), arrive
   * unterminated. `maxLineBytes` defaults to `chunkBytes`.
   */
  streamBytes(
    path: string,
    chunkBytes: number,
    onChunk: (chunk: Uint8Array) => void | Promise<void>,
    maxLineBytes?: number,
  ): Promise<boolean>;
  /** `lstat`: `undefined` when the path does not exist. */
  info(path: string): Promise<HostFileInfo | undefined>;
  /** The entries of a directory; `[]` when it does not exist. */
  list(directory: string): Promise<readonly HostDirEntry[]>;
  /** Temp file, flush, rename over the target, flush the directory (creates the directory `0700`). */
  writeAtomic(path: string, data: string | Uint8Array, mode: number): Promise<void>;
  /** Appends one record on a line of its own: a complete last record is closed with a newline, a torn one (cut short by a crash) is cut off first. */
  appendLine(path: string, line: string, mode: number): Promise<void>;
  ensureDirectory(path: string, mode: number): Promise<void>;
  createPrivateDirectory(path: string): Promise<void>;
  removeEmptyDirectory(path: string): Promise<void>;
  /** Removes a file or a whole folder; a path already gone is no error. */
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  setMode(path: string, mode: number): Promise<void>;
}

/** Where the last line begins: just past the last newline, searching backwards in chunks. */
async function startOfLastLine(handle: FileHandle, size: number): Promise<number> {
  const chunk = 64 * 1024;
  for (let end = size; end > 0; end -= chunk) {
    const from = Math.max(0, end - chunk);
    const buffer = new Uint8Array(end - from);
    await handle.read(buffer, 0, buffer.byteLength, from);
    const at = buffer.lastIndexOf(0x0a);
    if (at >= 0) return from + at + 1;
  }
  return 0;
}

export function isCompleteRecord(bytes: Uint8Array): boolean {
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return true;
  } catch {
    return false;
  }
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';

export interface NodeHostFsOptions {
  /** Fault tests wrap the file operations; production uses the node ones. */
  readonly files?: FileOperations;
  readonly tempNames?: TempNameSource;
}

/** The production {@link HostFs}: `node:fs/promises` through the atomic writer. */
export function createNodeHostFs(options: NodeHostFsOptions = {}): HostFs {
  const files = options.files ?? new NodeFileOperations();
  const writer = new AtomicFileWriter(files, options.tempNames ?? new RandomTempNameSource());
  return {
    async readText(path) {
      return (await writer.read(path)) ?? undefined;
    },
    async readBytes(path) {
      return (await writer.readBytes(path)) ?? undefined;
    },
    async readTail(path, maxBytes) {
      let handle: FileHandle;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw new Error('not a regular file');
        const from = Math.max(0, stats.size - maxBytes);
        const bytes = new Uint8Array(stats.size - from);
        let read = 0;
        while (read < bytes.byteLength) {
          const { bytesRead } = await handle.read(bytes, read, bytes.byteLength - read, from + read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        return { bytes: bytes.subarray(0, read), from };
      } finally {
        await handle.close();
      }
    },
    async streamBytes(path, chunkBytes, onChunk, maxLineBytes = chunkBytes) {
      let handle: FileHandle;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
      try {
        if (!(await handle.stat()).isFile()) throw new Error('not a regular file');
        // Positional reads: the next read begins at the line in progress, not where the last one stopped, so a line
        // is always read whole from its first byte and a rewritten tail is read as it now is.
        let buffer = new Uint8Array(chunkBytes);
        let position = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
          if (bytesRead === 0) return true;
          const lineEnd = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
          if (lineEnd >= 0) {
            await onChunk(buffer.subarray(0, lineEnd + 1));
            position += lineEnd + 1;
          } else if (bytesRead === buffer.byteLength && buffer.byteLength <= maxLineBytes) {
            // One line fills the buffer and may be longer: read it again with room for more of it.
            buffer = new Uint8Array(Math.min(buffer.byteLength * 2, maxLineBytes + 1));
          } else if (bytesRead === buffer.byteLength) {
            // A line past the limit: the reader counts it as too long, whatever its tail does.
            await onChunk(buffer.subarray(0, bytesRead));
            position += bytesRead;
          } else {
            // No newline and the file ended in this read: the last line, torn or not. It is handed over only once the
            // end is confirmed; if the file grew meanwhile the line is read again from its start.
            const end = await handle.read(new Uint8Array(1), 0, 1, position + bytesRead);
            if (end.bytesRead > 0) continue;
            await onChunk(buffer.subarray(0, bytesRead));
            return true;
          }
        }
      } finally {
        await handle.close();
      }
    },
    async info(path) {
      try {
        const stats = await lstat(path, { bigint: true });
        return {
          size: Number(stats.size),
          modifiedAtMs: Number(stats.mtimeNs) / 1_000_000,
          inode: Number(stats.ino),
          regularFile: stats.isFile(),
          directory: stats.isDirectory(),
          symlink: stats.isSymbolicLink(),
          device: stats.dev,
          changedAtNs: stats.ctimeNs,
        };
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    async list(directory) {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.map(entry => ({
          name: entry.name,
          directory: entry.isDirectory(),
          regularFile: entry.isFile(),
        }));
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    },
    async writeAtomic(path, data, mode) {
      await writer.write(path, data, mode);
    },
    async appendLine(path, line, mode) {
      await files.ensureDirectory(path.slice(0, path.lastIndexOf('/')), 0o700);
      const handle = await open(
        path,
        constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        mode,
      );
      try {
        const { size } = await handle.stat();
        let prefix = '';
        if (size > 0) {
          const last = new Uint8Array(1);
          await handle.read(last, 0, 1, size - 1);
          if (last[0] !== 0x0a) {
            // The last record has no newline. A complete one is kept and closed; a torn one (a crash cut it
            // short, nothing was ever acknowledged for it) is cut off, so it cannot turn into a bad line.
            const start = await startOfLastLine(handle, size);
            const tail = new Uint8Array(size - start);
            await handle.read(tail, 0, tail.byteLength, start);
            if (isCompleteRecord(tail)) prefix = '\n';
            else await handle.truncate(start);
          }
        }
        await handle.appendFile(`${prefix}${line}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async ensureDirectory(path, mode) {
      await mkdir(path, { recursive: true, mode });
    },
    async createPrivateDirectory(path) {
      await mkdir(path, { mode: 0o700 });
    },
    async removeEmptyDirectory(path) {
      try {
        await rmdir(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
    async remove(path) {
      await rm(path, { recursive: true, force: true });
    },
    async rename(from, to) {
      await rename(from, to);
    },
    async setMode(path, mode) {
      await chmod(path, mode);
    },
  };
}
