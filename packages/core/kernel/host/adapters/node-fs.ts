import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
import { dirname } from 'node:path';

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
  /** A link at `path` whose text is `target`; refused when anything is already there. */
  symlink(target: string, path: string): Promise<void>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** Atomic: a temp file in the same folder, fsync, rename. */
  writeAtomic(path: string, data: string | Uint8Array, mode?: number): Promise<void>;
  /** Create only (`O_CREAT|O_EXCL|O_NOFOLLOW`): refused when anything, a link included, is at the name. */
  writeExclusive(path: string, data: string | Uint8Array, mode: number): Promise<void>;
  list(path: string): Promise<readonly string[]>;
  remove(path: string): Promise<void>;
  mkdirp(path: string, mode?: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const isMissing = (error: unknown): boolean => (error as { code?: string }).code === 'ENOENT';

export function nodeFs(randomSuffix: () => string): HostFs {
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
    readText: path => readFile(path, 'utf8'),
    readBytes: async path => new Uint8Array(await readFile(path)),
    writeAtomic: async (path, data, mode = 0o600) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${randomSuffix()}.tmp`;
      const handle = await open(temp, 'wx', mode);
      try {
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
    writeExclusive: async (path, data, mode) => {
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        mode,
      );
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
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
  };
}
