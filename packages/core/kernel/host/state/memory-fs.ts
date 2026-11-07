import { type HostDirEntry, type HostFileInfo, type HostFs, isCompleteRecord } from './host-fs.ts';

interface Entry {
  readonly bytes: Uint8Array;
  readonly mode: number;
  readonly modifiedAtMs: number;
  readonly inode: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBytes = (data: string | Uint8Array): Uint8Array => (typeof data === 'string' ? encoder.encode(data) : data);

/** The in-memory {@link HostFs} a test host runs on: files by absolute path, folders implied by their files. */
export interface MemoryHostFs extends HostFs {
  /** Every file's text, by path, for assertions. */
  snapshot(): ReadonlyMap<string, string>;
  modeOf(path: string): number | undefined;
  /** Put a file there as if it were already on disk (a link-free fixture). */
  seed(path: string, data: string | Uint8Array, mode?: number): void;
  /** Make the next `writeAtomic` fail before it lands, as a crash between the scratch file and the rename does. */
  failNextWrite(error?: Error): void;
  /** Folders made with `ensureDirectory`, and their modes. */
  directoryModes(): ReadonlyMap<string, number>;
}

export function createMemoryHostFs(clock: () => number = () => 0): MemoryHostFs {
  const files = new Map<string, Entry>();
  const directories = new Map<string, number>();
  let inode = 1;
  let failure: Error | undefined;

  const put = (path: string, data: string | Uint8Array, mode: number): void => {
    files.set(path, { bytes: toBytes(data).slice(), mode, modifiedAtMs: clock(), inode: inode++ });
  };
  const isDirectory = (path: string): boolean => {
    if (directories.has(path)) return true;
    const prefix = `${path}/`;
    for (const key of files.keys()) if (key.startsWith(prefix)) return true;
    for (const key of directories.keys()) if (key.startsWith(prefix)) return true;
    return false;
  };

  return {
    async readText(path) {
      const entry = files.get(path);
      return entry === undefined ? undefined : decoder.decode(entry.bytes);
    },
    async readBytes(path) {
      return files.get(path)?.bytes.slice();
    },
    async info(path): Promise<HostFileInfo | undefined> {
      const entry = files.get(path);
      if (entry !== undefined)
        return {
          size: entry.bytes.byteLength,
          modifiedAtMs: entry.modifiedAtMs,
          inode: entry.inode,
          regularFile: true,
          directory: false,
        };
      return isDirectory(path)
        ? { size: 0, modifiedAtMs: 0, inode: 0, regularFile: false, directory: true }
        : undefined;
    },
    async list(directory): Promise<readonly HostDirEntry[]> {
      const prefix = `${directory}/`;
      const found = new Map<string, HostDirEntry>();
      for (const key of [...files.keys(), ...directories.keys()]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const name = rest.split('/')[0] ?? '';
        if (name === '') continue;
        const nested = rest.includes('/') || directories.has(key);
        const existing = found.get(name);
        if (existing === undefined || nested) found.set(name, { name, directory: nested, regularFile: !nested });
      }
      return [...found.values()];
    },
    async writeAtomic(path, data, mode) {
      if (failure !== undefined) {
        const error = failure;
        failure = undefined;
        throw error;
      }
      put(path, data, mode);
    },
    async appendLine(path, line, mode) {
      const existing = files.get(path);
      let current = existing === undefined ? '' : decoder.decode(existing.bytes);
      let prefix = '';
      if (current !== '' && !current.endsWith('\n')) {
        const start = current.lastIndexOf('\n') + 1;
        if (isCompleteRecord(encoder.encode(current.slice(start)))) prefix = '\n';
        else current = current.slice(0, start);
      }
      put(path, `${current}${prefix}${line}\n`, existing?.mode ?? mode);
    },
    async ensureDirectory(path, mode) {
      if (!directories.has(path)) directories.set(path, mode);
    },
    async remove(path) {
      files.delete(path);
      directories.delete(path);
      const prefix = `${path}/`;
      for (const key of [...files.keys()]) if (key.startsWith(prefix)) files.delete(key);
      for (const key of [...directories.keys()]) if (key.startsWith(prefix)) directories.delete(key);
    },
    async rename(from, to) {
      const prefix = `${from}/`;
      for (const [key, entry] of [...files]) {
        if (key === from) {
          files.delete(key);
          files.set(to, entry);
        } else if (key.startsWith(prefix)) {
          files.delete(key);
          files.set(`${to}/${key.slice(prefix.length)}`, entry);
        }
      }
      for (const [key, mode] of [...directories]) {
        if (key === from) {
          directories.delete(key);
          directories.set(to, mode);
        } else if (key.startsWith(prefix)) {
          directories.delete(key);
          directories.set(`${to}/${key.slice(prefix.length)}`, mode);
        }
      }
    },
    async setMode(path, mode) {
      const entry = files.get(path);
      if (entry !== undefined) files.set(path, { ...entry, mode });
      else directories.set(path, mode);
    },
    snapshot: () => new Map([...files].map(([path, entry]) => [path, decoder.decode(entry.bytes)])),
    modeOf: path => files.get(path)?.mode ?? directories.get(path),
    seed: (path, data, mode = 0o600) => put(path, data, mode),
    failNextWrite: error => {
      failure = error ?? new Error('simulated crash before the rename');
    },
    directoryModes: () => directories,
  };
}
