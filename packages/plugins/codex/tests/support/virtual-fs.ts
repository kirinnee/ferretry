/**
 * A VIRTUAL host filesystem for the kernel's real `rootsPortFor`: folders, files and symbolic links held in memory,
 * with every open and read recorded. Nothing here touches the disk, a real harness home or a real sign-in document.
 */
import { dirname, isAbsolute, join, normalize } from 'node:path';
import type { HostFs } from '@ferretry/kernel/host';

type Node =
  | { readonly kind: 'directory' }
  | { readonly kind: 'file'; readonly text: string }
  | { readonly kind: 'link'; readonly target: string };

type Identity = Awaited<ReturnType<HostFs['identity']>> & object;

const missing = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
const encoder = new TextEncoder();

export class VirtualFs {
  readonly #nodes = new Map<string, Node>([['/', { kind: 'directory' }]]);
  readonly #inodes = new Map<string, bigint>();
  /** Every real path opened to read (whatever was then read through it). */
  readonly opened: string[] = [];

  directory(path: string): this {
    for (let current = normalize(path); ; current = dirname(current)) {
      if (!this.#nodes.has(current)) this.#nodes.set(current, { kind: 'directory' });
      if (dirname(current) === current) break;
    }
    return this;
  }

  file(path: string, text: string): this {
    this.directory(dirname(path));
    this.#nodes.set(normalize(path), { kind: 'file', text });
    return this;
  }

  link(path: string, target: string): this {
    this.directory(dirname(path));
    this.#nodes.set(normalize(path), { kind: 'link', target });
    return this;
  }

  /** Every path resolved, links followed (at most 40 hops), like `realpath(3)`. */
  #resolve(path: string, followLeaf: boolean): string {
    const pending = normalize(path).split('/').filter(Boolean);
    let current = '/';
    for (let hops = 0; pending.length > 0; ) {
      const part = pending.shift() as string;
      const next = part === '..' ? dirname(current) : join(current, part);
      const node = this.#nodes.get(next);
      if (node === undefined) throw missing(next);
      if (node.kind === 'link' && (followLeaf || pending.length > 0)) {
        if (++hops > 40) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
        pending.unshift(...node.target.split('/').filter(Boolean));
        if (isAbsolute(node.target)) current = '/';
        continue;
      }
      current = next;
    }
    return current;
  }

  #identity(path: string): Identity | undefined {
    let at: string;
    try {
      at = this.#resolve(path, false);
    } catch {
      return undefined;
    }
    const node = this.#nodes.get(at);
    if (node === undefined) return undefined;
    if (!this.#inodes.has(at)) this.#inodes.set(at, BigInt(this.#inodes.size + 1));
    return {
      kind: node.kind,
      device: 1n,
      inode: this.#inodes.get(at) as bigint,
      links: 1,
      size: node.kind === 'file' ? node.text.length : 0,
      mtimeMs: 0,
      mtimeNs: 0n,
      ctimeNs: 0n,
      mode: node.kind === 'directory' ? 0o700 : 0o600,
      owner: 1000,
      group: 1000,
    };
  }

  get host(): HostFs {
    const unused = async (): Promise<never> => {
      throw new Error('not used by a read');
    };
    return {
      realpath: async path => this.#resolve(path, true),
      lstat: async path => this.#identity(path),
      identity: async path => this.#identity(path),
      openRead: async path => {
        const identity = this.#identity(path);
        // O_NOFOLLOW: a link at the last step is refused, never opened.
        if (identity === undefined || identity.kind !== 'file') throw missing(path);
        const real = this.#resolve(path, false);
        this.opened.push(real);
        const bytes = encoder.encode((this.#nodes.get(real) as { text: string }).text);
        return {
          identity,
          read: async limit => bytes.slice(0, limit ?? bytes.length),
          readWindow: async (offset, length) => {
            const start = offset < 0 ? Math.max(0, bytes.length + offset) : offset;
            return { bytes: bytes.slice(start, start + length), size: bytes.length };
          },
          sync: unused,
          chmod: unused,
          close: async () => undefined,
        };
      },
      openDirectory: async path => {
        const identity = this.#identity(path);
        if (identity === undefined || identity.kind !== 'directory') throw missing(path);
        return {
          identity,
          entryPath: () => undefined,
          openChild: unused,
          chmod: unused,
          sync: unused,
          close: async () => undefined,
        };
      },
      list: async path => {
        const real = this.#resolve(path, true);
        return [...this.#nodes.keys()]
          .filter(key => key !== real && dirname(key) === real)
          .map(key => key.slice(real === '/' ? 1 : real.length + 1));
      },
      readlink: async path => {
        const node = this.#nodes.get(this.#resolve(path, false));
        if (node?.kind !== 'link') throw missing(path);
        return node.target;
      },
      readText: async path => {
        this.opened.push(this.#resolve(path, true));
        throw new Error('roots read through a checked descriptor, never by name');
      },
      readBytes: unused,
      writeNew: unused,
      link: unused,
      mkdir: unused,
      symlink: unused,
      unlink: unused,
      rmdir: unused,
      writeAtomic: unused,
      remove: unused,
      mkdirp: unused,
      chmod: unused,
      rename: unused,
      groups: async () => [1000],
      writable: async () => false,
    };
  }
}
