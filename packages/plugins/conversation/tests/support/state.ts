import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { ok } from '@ferretry/std';

/**
 * A state port for the stores that keep byte files: the test host's memory folder models JSON documents only, so an
 * `opaque` or `secret` file is held here as the bytes it was given, exactly as the kernel's store reads and writes them
 * (`read` and `write` of a name-keyed collection, `list`, `remove`); everything else goes to the memory folder.
 */
export function memoryStatePort(declared: readonly StateFileDef[]): StatePort & {
  readonly bytes: Map<string, Uint8Array>;
  readonly folder: MemoryStateFolder;
} {
  const folder = new MemoryStateFolder();
  const inner = folder.port(declared);
  const bytes = new Map<string, Uint8Array>();
  const isBytes = (file: StateFileDef): boolean => file.store === 'opaque' || file.store === 'secret';
  const key = (file: StateFileDef, name?: string): string =>
    name === undefined ? file.path : file.path.replace('*', name);
  return {
    ...inner,
    bytes,
    folder,
    async read(file: StateFileDef, name?: string) {
      if (!isBytes(file)) return await inner.read(file, name);
      return ok(bytes.get(key(file, name)) as never);
    },
    async write(file: StateFileDef, value: unknown, name?: string) {
      if (!isBytes(file)) return await inner.write(file, value as never, name);
      bytes.set(key(file, name), typeof value === 'string' ? new TextEncoder().encode(value) : (value as Uint8Array));
    },
    async list(file: StateFileDef) {
      if (!isBytes(file)) return await inner.list(file);
      const [prefix, suffix] = file.path.split('*') as [string, string];
      return [...bytes.keys()]
        .filter(path => path.startsWith(prefix) && path.endsWith(suffix))
        .map(path => path.slice(prefix.length, path.length - suffix.length));
    },
    async remove(file: StateFileDef, name?: string) {
      if (!isBytes(file)) return await inner.remove(file, name);
      bytes.delete(key(file, name));
    },
  } as never;
}
