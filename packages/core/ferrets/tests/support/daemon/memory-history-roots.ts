import type {
  FencedPath,
  RootEntry,
  RootHandle,
  RootName,
  RootStat,
  RootsPort,
  SharedTree,
} from '@ferretry/kernel/contract';
import { MAX_ROOT_WINDOW_BYTES } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { err, ok } from '@ferretry/std';

/**
 * `RootsPort` over a map of absolute files, for the roots scoped to one folder by an absolute `subfolder` (the
 * `harness-history` and `imports` roots). A handle resolves relative names beneath its folder only, and refuses `..`,
 * as the kernel's roots do; reads fail for a file in `unreadable`; a read-only root (the real `harness-history`)
 * refuses every write.
 */
export class MemoryHistoryRoots implements RootsPort {
  readonly files = new Map<string, { bytes: Uint8Array; modifiedMs: number }>();
  readonly unreadable = new Set<string>();
  readonly scopes: string[] = [];

  constructor(private readonly options: { readonly readOnly?: boolean } = {}) {}

  plant(path: string, body: string | Uint8Array, modifiedSeconds = 0): void {
    this.files.set(path, {
      bytes: typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body),
      modifiedMs: modifiedSeconds * 1000,
    });
  }

  text(path: string): string | undefined {
    const file = this.files.get(path);
    return file === undefined ? undefined : new TextDecoder().decode(file.bytes);
  }

  share(): Promise<SharedTree> {
    return Promise.reject(new Error('the history roots share nothing'));
  }

  root(name: RootName, scope?: { readonly subfolder?: string }): RootHandle {
    const folder = scope?.subfolder;
    if (folder === undefined || !folder.startsWith('/')) throw new Error(`the ${name} root needs an absolute folder`);
    this.scopes.push(folder);
    const files = this.files;
    const unreadable = this.unreadable;
    const readOnly = this.options.readOnly === true;
    const directory = (path: string): boolean => [...files.keys()].some(key => key.startsWith(`${path}/`));
    const refuse = (what: string): never => {
      throw new Error(`${what}: the ${name} root is read-only`);
    };
    const read = (path: FencedPath): Uint8Array => {
      const file = files.get(path);
      if (file === undefined || unreadable.has(path)) throw new Error(`cannot read ${path}`);
      return file.bytes;
    };
    const stat = (path: string): RootStat | undefined => {
      const file = files.get(path);
      if (file !== undefined)
        return {
          kind: 'file',
          size: file.bytes.byteLength,
          modified: new Date(file.modifiedMs).toISOString() as Instant,
          mode: 0o600,
          links: 1,
        };
      return directory(path)
        ? { kind: 'directory', size: 0, modified: new Date(0).toISOString() as Instant, mode: 0o700, links: 1 }
        : undefined;
    };
    const handle: Partial<RootHandle> = {
      name,
      resolve: relative =>
        relative.startsWith('/') || relative.split('/').includes('..')
          ? err('outside')
          : ok((relative === '.' ? folder : `${folder.replace(/\/+$/u, '')}/${relative}`) as FencedPath),
      readText: async (path, limit) => {
        const bytes = read(path);
        if (limit !== undefined && bytes.byteLength > limit) throw new Error('over the limit');
        return new TextDecoder().decode(bytes);
      },
      readBytes: async (path, limitOrWindow) => {
        const bytes = read(path);
        if (limitOrWindow === undefined) return bytes;
        if (typeof limitOrWindow === 'number') {
          if (bytes.byteLength > limitOrWindow) throw new Error('over the limit');
          return bytes;
        }
        if (limitOrWindow.length > MAX_ROOT_WINDOW_BYTES) throw new Error('the window is out of range');
        return bytes.slice(limitOrWindow.offset, limitOrWindow.offset + limitOrWindow.length);
      },
      writeBytes: async (path, bytes) => {
        if (readOnly) refuse(`cannot write ${path}`);
        files.set(path, { bytes: new Uint8Array(bytes), modifiedMs: 0 });
      },
      makeDirectory: async path => {
        if (readOnly) refuse(`cannot make ${path}`);
      },
      stat: async path => stat(path),
      entries: async path => {
        const prefix = `${path}/`;
        const names = new Set<string>();
        for (const key of files.keys())
          if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0] ?? '');
        return [...names].map(
          (entryName): RootEntry => ({ name: entryName, ...(stat(`${prefix}${entryName}`) as RootStat) }),
        );
      },
    };
    return handle as RootHandle;
  }
}
