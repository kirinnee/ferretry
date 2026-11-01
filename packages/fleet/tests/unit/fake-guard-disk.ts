import { basename, dirname, join } from 'node:path';
import type {
  FileIdentity,
  GuardDirectoryHandle,
  GuardDisk,
  GuardReadHandle,
  GuardWriteHandle,
} from '../../src/lib/state-home-guard.ts';

/** A file or folder: an inode several paths may share (hard links), mutated in place through any of them. */
type Node =
  | { kind: 'file'; readonly inode: bigint; size: number; mode: number; text: string }
  | { kind: 'directory'; readonly inode: bigint; mode: number }
  | { kind: 'other'; readonly inode: bigint; mode: number };
type Entry = Node | { readonly kind: 'link'; readonly target: string };

const errno = (code: string, path: string): Error => Object.assign(new Error(`${code} ${path}`), { code });

/**
 * An in-memory disk resolved the way a POSIX one resolves: symlinks at any step, hard links as two names of one
 * inode, a folder opened by descriptor (its entries reached through `/@fd/<n>/<leaf>`, which follows the
 * FOLDER, not its path), and hooks to swap entries between the guard's steps.
 */
export class FakeGuardDisk implements GuardDisk {
  readonly entries = new Map<string, Entry>();
  readonly modes: Array<readonly [string, number]> = [];
  readonly removed: string[] = [];
  readonly unlinked: string[] = [];
  readonly written: string[] = [];
  /** Runs before an open of `path`, and may throw like a refused open. */
  beforeOpen: ((path: string) => void) | undefined;
  /** Runs once `path` is opened: what a same-user process could do between the check and the use. */
  afterOpen: ((path: string) => void) | undefined;
  afterMkdirp: ((path: string) => void) | undefined;
  failRemove = false;
  failList = false;
  private nextInode = 2n;
  private readonly folders = new Map<number, bigint>();

  constructor(readonly throughDescriptors = true) {
    this.entries.set('/', { kind: 'directory', inode: 1n, mode: 0o755 });
  }

  private inode(): bigint {
    this.nextInode += 1n;
    return this.nextInode;
  }

  dir(path: string, mode = 0o755): void {
    this.entries.set(path, { kind: 'directory', inode: this.inode(), mode });
  }
  file(path: string, size: number, text = '', mode = 0o644): void {
    this.entries.set(path, { kind: 'file', inode: this.inode(), size, mode, text });
  }
  pipe(path: string): void {
    this.entries.set(path, { kind: 'other', inode: this.inode(), mode: 0o644 });
  }
  link(path: string, target: string): void {
    this.entries.set(path, { kind: 'link', target });
  }
  /** A second name for the inode at `existing`. */
  hardLink(path: string, existing: string): void {
    const entry = this.entries.get(existing);
    if (entry === undefined) throw errno('ENOENT', existing);
    this.entries.set(path, entry);
  }
  /** Mounts the folder at `source` again at `at`, as `mount --bind` does: the same inodes under a second path. */
  bind(at: string, source: string): void {
    for (const [key, entry] of [...this.entries])
      if (key === source || key.startsWith(`${source}/`)) this.entries.set(`${at}${key.slice(source.length)}`, entry);
  }
  /** Renames `from` (and everything under it) to `to`, as `rename(2)` does. */
  move(from: string, to: string): void {
    for (const [key, entry] of [...this.entries])
      if (key === from || key.startsWith(`${from}/`)) {
        this.entries.delete(key);
        this.entries.set(`${to}${key.slice(from.length)}`, entry);
      }
  }
  /** A `/@fd/<n>/<leaf>` path, as the folder it names is NOW. */
  private translate(path: string): string {
    const match = /^\/@fd\/(\d+)\/(.+)$/u.exec(path);
    if (match === null) return path;
    const inode = this.folders.get(Number(match[1]));
    const folder = [...this.entries].find(([, entry]) => entry.kind === 'directory' && entry.inode === inode)?.[0];
    if (folder === undefined) throw errno('EBADF', path);
    return join(folder, match[2] as string);
  }

  async realpath(path: string): Promise<string> {
    let current = '/';
    const pending = this.translate(path)
      .split('/')
      .filter(part => part !== '' && part !== '.');
    let hops = 0;
    while (pending.length > 0) {
      const segment = pending.shift() as string;
      const next = segment === '..' ? dirname(current) : join(current, segment);
      const entry = this.entries.get(next);
      if (entry === undefined) throw errno('ENOENT', next);
      if (entry.kind === 'link') {
        hops += 1;
        if (hops > 40) throw errno('ELOOP', next);
        if (entry.target.startsWith('/')) current = '/';
        pending.unshift(...entry.target.split('/').filter(part => part !== '' && part !== '.'));
      } else current = next;
    }
    return current;
  }

  private async lookup(path: string): Promise<{ readonly key: string; readonly entry: Entry | undefined }> {
    const translated = this.translate(path);
    if (translated === '/') return { key: '/', entry: this.entries.get('/') };
    const folder = await this.realpath(dirname(translated));
    const key = join(folder, basename(translated));
    return { key, entry: this.entries.get(key) };
  }

  private links(node: Node): number {
    return [...this.entries.values()].filter(entry => entry === node).length;
  }

  private identityOf(entry: Entry): FileIdentity {
    if (entry.kind === 'link') return { kind: 'link', device: 7n, inode: 0n, links: 1, size: 0, mode: 0o777 };
    return {
      kind: entry.kind,
      device: 7n,
      inode: entry.inode,
      links: this.links(entry),
      size: entry.kind === 'file' ? entry.size : 0,
      mode: entry.mode,
    };
  }

  async identity(path: string): Promise<FileIdentity | undefined> {
    const found = await this.lookup(path).catch(() => undefined);
    return found?.entry === undefined ? undefined : this.identityOf(found.entry);
  }

  private async opened(path: string): Promise<Node> {
    this.beforeOpen?.(path);
    const { entry } = await this.lookup(path);
    if (entry === undefined) throw errno('ENOENT', path);
    if (entry.kind === 'link') throw errno('ELOOP', path);
    this.afterOpen?.(path);
    return entry;
  }

  async openRead(path: string): Promise<GuardReadHandle> {
    const node = await this.opened(path);
    const identity = this.identityOf(node);
    const size = (maxBytes: number): number => {
      const bytes = node.kind === 'file' ? node.size : 0;
      if (bytes > maxBytes) throw new Error(`over ${String(maxBytes)} bytes`);
      return bytes;
    };
    return {
      identity,
      copyTo: async (to, maxBytes, mode) => {
        const bytes = size(maxBytes);
        const { key, entry } = await this.lookup(to);
        if (entry !== undefined) throw errno('EEXIST', to);
        this.file(key, bytes, node.kind === 'file' ? node.text : '', mode);
        this.written.push(key);
        return bytes;
      },
      readText: async maxBytes => {
        size(maxBytes);
        return node.kind === 'file' ? node.text : '';
      },
      close: async () => undefined,
    };
  }

  async openDirectory(path: string): Promise<GuardDirectoryHandle> {
    const node = await this.opened(path);
    if (node.kind !== 'directory') throw errno('ENOTDIR', path);
    const fd = this.folders.size + 3;
    this.folders.set(fd, node.inode);
    return {
      identity: this.identityOf(node),
      entryPath: leaf => (this.throughDescriptors ? `/@fd/${String(fd)}/${leaf}` : undefined),
      close: async () => undefined,
    };
  }

  async openWrite(path: string, how: 'new' | 'existing', mode: number): Promise<GuardWriteHandle | 'taken' | 'absent'> {
    this.beforeOpen?.(path);
    const { key, entry } = await this.lookup(path);
    if (entry?.kind === 'link') throw errno('ELOOP', path);
    if (how === 'new' && entry !== undefined) return 'taken';
    if (how === 'existing' && entry === undefined) return 'absent';
    if (entry?.kind === 'directory') throw errno('EISDIR', path);
    if (entry === undefined) this.file(key, 0, '', mode);
    const node = this.entries.get(key) as Node;
    this.afterOpen?.(path);
    return {
      identity: this.identityOf(node),
      truncate: async () => {
        if (node.kind === 'file') node.size = 0;
      },
      copyFrom: async (source, maxBytes) => {
        const from = this.entries.get(await this.realpath(source));
        const bytes = from?.kind === 'file' ? from.size : 0;
        if (bytes > maxBytes) throw new Error(`over ${String(maxBytes)} bytes`);
        if (node.kind === 'file') node.size = bytes;
        this.written.push(key);
        return bytes;
      },
      close: async () => undefined,
    };
  }

  async readlink(path: string): Promise<string> {
    const { entry } = await this.lookup(path);
    if (entry?.kind !== 'link') throw errno('EINVAL', path);
    return entry.target;
  }

  async list(path: string): Promise<readonly string[]> {
    if (this.failList) throw errno('EACCES', path);
    const folder = await this.realpath(path);
    const prefix = folder === '/' ? '/' : `${folder}/`;
    return [...this.entries.keys()]
      .filter(key => key !== folder && key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .map(key => key.slice(prefix.length));
  }

  async mkdir(path: string, mode: number): Promise<void> {
    const { key, entry } = await this.lookup(path);
    if (entry !== undefined) throw errno('EEXIST', path);
    this.dir(key, mode);
    this.modes.push([key, mode]);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const { entry } = await this.lookup(path);
    if (entry === undefined || entry.kind === 'link') throw errno('ENOENT', path);
    entry.mode = mode;
  }

  async mkdirp(path: string, mode: number): Promise<void> {
    let current = '/';
    for (const segment of path.split('/').filter(part => part !== '')) {
      current = join(await this.realpath(current), segment);
      if (!this.entries.has(current)) this.dir(current, mode);
    }
    this.modes.push([path, mode]);
    this.afterMkdirp?.(path);
  }

  async writeNew(path: string, bytes: Uint8Array, mode: number): Promise<void> {
    this.file(path, bytes.byteLength, '', mode);
    this.modes.push([path, mode]);
  }

  async unlink(path: string): Promise<void> {
    const { key } = await this.lookup(path);
    this.unlinked.push(key);
    this.entries.delete(key);
  }

  async remove(path: string): Promise<void> {
    this.removed.push(path);
    if (this.failRemove) throw errno('EBUSY', path);
    for (const key of [...this.entries.keys()])
      if (key === path || key.startsWith(`${path}/`)) this.entries.delete(key);
  }
}
