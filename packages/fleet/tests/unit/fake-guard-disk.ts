import { basename, dirname, join } from 'node:path';
import type {
  DescriptorCalls,
  FileIdentity,
  GuardDirectoryHandle,
  GuardDisk,
  GuardReadHandle,
  GuardWriteHandle,
} from '../../src/lib/state-home-guard.ts';

/** A file or folder: an inode several paths may share (hard links), mutated in place through any of them. */
type Node =
  | { kind: 'file'; readonly inode: bigint; size: number; mode: number; text: string; owner?: number; group?: number }
  | { kind: 'directory'; readonly inode: bigint; mode: number; owner?: number; group?: number }
  | { kind: 'other'; readonly inode: bigint; mode: number; owner?: number; group?: number };
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
  /** Every path opened to read, in order. */
  readonly reads: string[] = [];
  /** Runs before an open of `path`, and may throw like a refused open. */
  beforeOpen: ((path: string) => void) | undefined;
  /** Runs once `path` is opened: what a same-user process could do between the check and the use. */
  afterOpen: ((path: string) => void) | undefined;
  afterMkdirp: ((path: string) => void) | undefined;
  failRemove = false;
  failList = false;
  /** This process's group ids, as `groups()` answers them. */
  groupIds: readonly number[] = [1000, 100];
  /** Real paths `access(W_OK)` allows beyond what the mode bits say — an ACL, say. */
  readonly writableAt = new Set<string>();
  private nextInode = 2n;
  private readonly folders = new Map<number, bigint>();

  /** Files made through descriptor calls, by the fake descriptor each was handed back as. */
  private readonly madeFiles = new Map<number, string>();
  private nextFile = 1000;
  private readonly handleFds = new WeakMap<GuardDirectoryHandle, number>();

  /**
   * `true`: a folder's entries are reached through `/@fd/<n>/<leaf>` (Linux). `'calls'`: through descriptor calls on
   * the handle, with no such path (macOS). `false`: by path only.
   */
  constructor(readonly throughDescriptors: boolean | 'calls' = true) {
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
  /** Gives the entry at `path` an owner and mode, as `chown` and `chmod` do. */
  own(path: string, owner: number, mode: number, group = 0): void {
    const entry = this.entries.get(path);
    if (entry === undefined || entry.kind === 'link') throw errno('ENOENT', path);
    entry.owner = owner;
    entry.group = group;
    entry.mode = mode;
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
    if (entry.kind === 'link')
      return { kind: 'link', device: 7n, inode: 0n, links: 1, size: 0, mode: 0o777, owner: 1000, group: 100 };
    return {
      kind: entry.kind,
      device: 7n,
      inode: entry.inode,
      links: this.links(entry),
      size: entry.kind === 'file' ? entry.size : 0,
      mode: entry.mode,
      owner: entry.owner ?? 1000,
      group: entry.group ?? 100,
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
    this.reads.push(path);
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
      copyToDescriptor: async (descriptor, maxBytes) => {
        const bytes = size(maxBytes);
        const key = this.madeFiles.get(descriptor);
        const made = key === undefined ? undefined : this.entries.get(key);
        if (made?.kind !== 'file') throw errno('EBADF', String(descriptor));
        made.size = bytes;
        made.text = node.kind === 'file' ? node.text : '';
        this.written.push(key as string);
        return bytes;
      },
      readText: async maxBytes => {
        size(maxBytes);
        return node.kind === 'file' ? node.text : '';
      },
      close: async () => undefined,
    };
  }

  /** The descriptor calls of the folder held as `fd`: every step through `/@fd/<fd>/<leaf>`, which follows the FOLDER. */
  private calls(fd: number): DescriptorCalls {
    const at = (leaf: string): string => `/@fd/${String(fd)}/${leaf}`;
    return {
      identity: async leaf => await this.identity(at(leaf)),
      list: async () => await this.list(at('.')),
      mkdir: async (leaf, mode) => await this.mkdir(at(leaf), mode),
      openDirectory: async leaf => await this.openDirectory(at(leaf)),
      unlink: async leaf => await this.unlink(at(leaf)),
      rmdir: async leaf => await this.rmdir(at(leaf)),
      rename: async (from, to) => await this.rename(at(from), at(to)),
      symlink: async (target, leaf) => await this.symlink(target, at(leaf)),
      readlink: async leaf => await this.readlink(at(leaf)),
      link: async (fromLeaf, into, toLeaf) =>
        await this.linkEntry(at(fromLeaf), `/@fd/${String(this.handleFds.get(into))}/${toLeaf}`),
      renameInto: async (fromLeaf, into, toLeaf) =>
        await this.rename(at(fromLeaf), `/@fd/${String(this.handleFds.get(into))}/${toLeaf}`),
      openFile: async (leaf, how, mode) => {
        const { key, entry } = await this.lookup(at(leaf));
        if (how !== 'new') throw errno('ENOTSUP', at(leaf));
        if (entry !== undefined) throw errno('EEXIST', at(leaf));
        this.file(key, 0, '', mode);
        this.nextFile += 1;
        this.madeFiles.set(this.nextFile, key);
        return this.nextFile;
      },
    };
  }

  async openDirectory(path: string): Promise<GuardDirectoryHandle> {
    const node = await this.opened(path);
    if (node.kind !== 'directory') throw errno('ENOTDIR', path);
    const fd = this.folders.size + 3;
    this.folders.set(fd, node.inode);
    const handle: GuardDirectoryHandle = {
      identity: this.identityOf(node),
      entryPath: leaf => (this.throughDescriptors === true ? `/@fd/${String(fd)}/${leaf}` : undefined),
      ...(this.throughDescriptors === 'calls' ? { at: this.calls(fd) } : {}),
      chmod: async mode => {
        node.mode = mode;
        this.modes.push([`@fd:${String(fd)}`, mode]);
      },
      close: async () => undefined,
    };
    this.handleFds.set(handle, fd);
    return handle;
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
    this.afterMkdirp?.(key);
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

  async groups(): Promise<readonly number[]> {
    return this.groupIds;
  }

  /** As `access(W_OK)` answers for uid 1000: owner bits for its own entries, group bits for its groups, other bits, or an ACL. */
  async writable(path: string): Promise<boolean> {
    const real = await this.realpath(path);
    const entry = this.entries.get(real);
    if (entry === undefined || entry.kind === 'link') throw errno('ENOENT', path);
    if (this.writableAt.has(real)) return true;
    const owner = entry.owner ?? 1000;
    const group = entry.group ?? 100;
    if (owner === 1000) return (entry.mode & 0o200) !== 0;
    if (this.groupIds.includes(group)) return (entry.mode & 0o020) !== 0;
    return (entry.mode & 0o002) !== 0;
  }

  async unlink(path: string): Promise<void> {
    const { key, entry } = await this.lookup(path);
    if (entry === undefined) throw errno('ENOENT', path);
    if (entry.kind === 'directory') throw errno('EISDIR', path);
    this.unlinked.push(key);
    this.entries.delete(key);
  }

  /** Renames an entry (and everything under it), never following either final step (`rename(2)`). */
  async rename(from: string, to: string): Promise<void> {
    const source = await this.lookup(from);
    if (source.entry === undefined) throw errno('ENOENT', from);
    const target = await this.lookup(to);
    this.move(source.key, target.key);
  }

  /** A symbolic link at `path` to `target`, failing when the name is taken (`symlink(2)`). */
  async symlink(target: string, path: string): Promise<void> {
    const { key, entry } = await this.lookup(path);
    if (entry !== undefined) throw errno('EEXIST', path);
    this.link(key, target);
  }

  /** A second name `to` for the entry at `from` (`link(2)`). */
  async linkEntry(from: string, to: string): Promise<void> {
    const source = await this.lookup(from);
    const target = await this.lookup(to);
    if (source.entry === undefined) throw errno('ENOENT', from);
    if (target.entry !== undefined) throw errno('EEXIST', to);
    this.entries.set(target.key, source.entry);
  }

  /** This disk has no descriptors to hand out. */
  async openFile(path: string): Promise<number> {
    throw errno('ENOTSUP', path);
  }

  /** Removes an EMPTY folder, never following a link (`rmdir(2)`). */
  async rmdir(path: string): Promise<void> {
    const { key, entry } = await this.lookup(path);
    if (entry === undefined) throw errno('ENOENT', path);
    if (entry.kind !== 'directory') throw errno('ENOTDIR', path);
    if ([...this.entries.keys()].some(other => other.startsWith(`${key}/`))) throw errno('ENOTEMPTY', path);
    this.removed.push(key);
    this.entries.delete(key);
  }

  async remove(path: string): Promise<void> {
    this.removed.push(path);
    if (this.failRemove) throw errno('EBUSY', path);
    for (const key of [...this.entries.keys()])
      if (key === path || key.startsWith(`${path}/`)) this.entries.delete(key);
  }
}
