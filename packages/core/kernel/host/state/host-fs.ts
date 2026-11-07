import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
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
  /** `lstat`: `undefined` when the path does not exist. */
  info(path: string): Promise<HostFileInfo | undefined>;
  /** The entries of a directory; `[]` when it does not exist. */
  list(directory: string): Promise<readonly HostDirEntry[]>;
  /** Temp file, flush, rename over the target, flush the directory (creates the directory `0700`). */
  writeAtomic(path: string, data: string | Uint8Array, mode: number): Promise<void>;
  /** Appends one record on a line of its own: a complete last record is closed with a newline, a torn one (cut short by a crash) is cut off first. */
  appendLine(path: string, line: string, mode: number): Promise<void>;
  ensureDirectory(path: string, mode: number): Promise<void>;
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
    async info(path) {
      try {
        const stats = await lstat(path);
        return {
          size: stats.size,
          modifiedAtMs: stats.mtimeMs,
          inode: stats.ino,
          regularFile: stats.isFile(),
          directory: stats.isDirectory(),
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
