/**
 * Test doubles for the read seam of the adapters (`HostFiles`, `daemon/adapters/ports.ts`), backed by a temporary directory a test made.
 *
 * Tests are exempt from `banned-globals`: they stand in for the kernel's host, so they may touch `node:fs`. Nothing
 * here is shipped, and none of it reads a real home.
 */
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import type { HostEntry, HostFiles } from '../../../daemon/adapters/ports.ts';

const missing = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const kindOf = (entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): HostEntry['kind'] =>
  entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : 'other';

/** {@link HostFiles} over the real disk below a temp directory. */
export const nodeHostFiles: HostFiles = {
  readText: async path => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  },
  readBytes: async path => {
    try {
      return await readFile(path);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  },
  stat: async path => {
    try {
      const entry = await stat(path);
      return { kind: kindOf(entry), size: entry.size };
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  },
  lstat: async path => {
    try {
      const entry = await lstat(path);
      return { kind: kindOf(entry), size: entry.size };
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  },
  list: async path => {
    try {
      return await readdir(path);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  },
};
