/** Live adapters over the SAME state store the state port and linkHistory use, never a copied snapshot. */
import type { MemoryStateFolder } from './state.ts';
import { posix } from 'node:path';
import { RootError } from '../host/roots.ts';

class StringMap extends Map<string, string> {
  constructor(
    readonly all: () => Iterable<readonly [string, string]>,
    readonly put: (key: string, value: string) => void,
    readonly drop: (key: string) => boolean,
  ) {
    super();
  }
  override get(key: string): string | undefined {
    return [...this.all()].find(([name]) => name === key)?.[1];
  }
  override has(key: string): boolean {
    return this.get(key) !== undefined;
  }
  override set(key: string, value: string): this {
    this.put(key, value);
    return this;
  }
  override delete(key: string): boolean {
    return this.drop(key);
  }
  override get size(): number {
    return [...this.all()].length;
  }
  override entries(): MapIterator<[string, string]> {
    return new Map(this.all()).entries();
  }
  override keys(): MapIterator<string> {
    return new Map(this.all()).keys();
  }
  override values(): MapIterator<string> {
    return new Map(this.all()).values();
  }
  override [Symbol.iterator](): MapIterator<[string, string]> {
    return this.entries();
  }
}

class FolderSet extends Set<string> {
  constructor(
    readonly state: MemoryStateFolder,
    readonly prefix: string,
    readonly now: () => number,
  ) {
    super();
  }
  override has(key: string): boolean {
    return this.state.directories.has(key.slice(this.prefix.length));
  }
  override add(key: string): this {
    const path = key.slice(this.prefix.length);
    if (!this.state.directories.has(path)) this.state.directories.set(path, { mode: 0o700, modifiedMs: this.now() });
    return this;
  }
  override delete(key: string): boolean {
    return this.state.directories.delete(key.slice(this.prefix.length));
  }
  override values(): SetIterator<string> {
    return new Set([...this.state.directories.keys()].map(key => this.prefix + key)).values();
  }
  override [Symbol.iterator](): SetIterator<string> {
    return this.values();
  }
}

/** A pool view's flat-world namespace is its real link target: `/state/<plugin>/<folder>`. */
export function memoryPoolStore(state: MemoryStateFolder, plugin: string, folder: string, now: () => number) {
  const prefix = `/state/${plugin}/`;
  const absolute = (key: string): string => prefix + key;
  const base = absolute(folder);
  const relative = (key: string): string => {
    if (key.includes('\0') || key.split('/').includes('..')) throw new RootError('outside');
    const full = posix.normalize(key.startsWith('/') ? key : posix.join(base, key)).replace(/(?<=.)\/+$/u, '');
    if (full !== base && !full.startsWith(base + '/')) throw new RootError('outside');
    return full.slice(prefix.length);
  };
  const inside = (key: string): boolean => key === folder || key.startsWith(folder + '/');
  const files = new StringMap(
    () => [
      ...[...state.files].filter(([key]) => inside(key)).map(([key, text]) => [absolute(key), text] as const),
      ...[...state.bytes]
        .filter(([key]) => inside(key))
        .map(([key, bytes]) => [absolute(key), new TextDecoder().decode(bytes)] as const),
    ],
    (key, text) => {
      state.files.delete(relative(key));
      state.bytes.set(relative(key), new TextEncoder().encode(text));
    },
    key => {
      const text = state.files.delete(relative(key));
      state.hardLinks.delete(relative(key));
      return state.bytes.delete(relative(key)) || text;
    },
  );
  const links = new StringMap(
    () => [...state.symlinks].filter(([key]) => inside(key)).map(([key, target]) => [absolute(key), target] as const),
    (key, target) => {
      state.symlinks.set(relative(key), target);
    },
    key => state.symlinks.delete(relative(key)),
  );
  const folders = new FolderSet(state, prefix, now);
  const checked = (path: string, keepLeaf = false): string => {
    const key = relative(path);
    const parts = key.split('/');
    const through = keepLeaf ? parts.length - 1 : parts.length;
    for (let index = 1; index <= through; index += 1) {
      const at = parts.slice(0, index).join('/');
      if (state.symlinks.has(at)) throw new RootError('link_escape');
      if (index < parts.length && (state.files.has(at) || state.bytes.has(at))) throw new RootError('link_escape');
    }
    return absolute(key);
  };
  return {
    base,
    files,
    links,
    folders,
    checked,
    hardLinked: (path: string): boolean => state.hardLinks.has(relative(path)),
    markHardLink: (path: string): void => {
      state.hardLinks.add(relative(path));
    },
    version: (path: string): Uint8Array | string | undefined =>
      state.bytes.get(relative(path)) ?? state.files.get(relative(path)),
    read: (key: string): Uint8Array | undefined => {
      const bytes = state.bytes.get(relative(key));
      if (bytes !== undefined) return new Uint8Array(bytes);
      const text = state.files.get(relative(key));
      return text === undefined ? undefined : new TextEncoder().encode(text);
    },
    write: (key: string, bytes: Uint8Array): void => {
      state.files.delete(relative(key));
      state.bytes.set(relative(key), new Uint8Array(bytes));
    },
  };
}
