/**
 * Test doubles for the adapter seams (`daemon/adapters/ports.ts`), backed by a temporary directory a test made.
 *
 * Tests are exempt from `banned-globals`: they stand in for the kernel's host, so they may touch `node:fs`. Nothing
 * here is shipped, and none of it reads a real home.
 */
import { closeSync, constants, fchmodSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { cp, lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import type {
  CommandLocator,
  FileIdentity,
  HostEntry,
  HostFiles,
  ProvisionerDisk,
  TextStore,
} from '../../../daemon/adapters/ports.ts';
import { atomicTextWrite } from './text-write.ts';

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

/** {@link TextStore} over the real disk: a rename-into-place write. */
export const nodeTextStore: TextStore = {
  read: async path => (await nodeHostFiles.readText(path)) ?? null,
  write: async (path, text) => {
    await atomicTextWrite(path, text);
  },
};

/** {@link CommandLocator} that finds the named commands and nothing else. */
export const fixedCommands = (found: Readonly<Record<string, string>>): CommandLocator => ({
  which: name => found[name],
});

const READ_PROOF = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** {@link ProvisionerDisk} over the real disk: the calls the provisioner made directly before the port. */
export const nodeProvisionerDisk: ProvisionerDisk = {
  realpath: async path => await realpath(path),
  statIsDirectory: async path => (await stat(path)).isDirectory(),
  readText: async path => await readFile(path, 'utf8'),
  readBytes: async path => await readFile(path),
  list: async path => await readdir(path),
  identity: async path => {
    const entry = await lstat(path, { bigint: true });
    const identity: FileIdentity = {
      kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : 'other',
      device: entry.dev,
      inode: entry.ino,
      links: Number(entry.nlink),
      size: Number(entry.size),
      mode: Number(entry.mode) & 0o7777,
      owner: Number(entry.uid),
      group: Number(entry.gid),
      modified: entry.mtimeNs,
      changed: entry.ctimeNs,
    };
    return identity;
  },
  copyTree: async (source, destination, options) => {
    await cp(source, destination, { recursive: options.recursive, dereference: true });
  },
  openForProof: path => openSync(path, READ_PROOF),
  isRegular: descriptor => fstatSync(descriptor).isFile(),
  readAt: (descriptor, buffer, offset, length, position) => readSync(descriptor, buffer, offset, length, position),
  write: (descriptor, bytes, offset, length) => writeSync(descriptor, bytes, offset, length),
  fchmod: (descriptor, mode) => {
    fchmodSync(descriptor, mode);
  },
  close: descriptor => {
    closeSync(descriptor);
  },
};
