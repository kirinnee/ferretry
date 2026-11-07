/** In-memory stand-ins for the sweep's world: a worktrees root with links, and a clock. */
import type { FencedPath } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { err, ok } from '@ferretry/std';
import type { ScratchFolders, ScratchLstat } from '../../daemon/lib/scratch-collector.ts';

export const ROOT = '/wt';
export const HOUR = 3_600_000;
export const NOW = Date.parse('2026-11-07T12:00:00.000Z');
export const at = (ms: number): Instant => new Date(ms).toISOString() as Instant;

interface Node {
  kind: ScratchLstat['kind'];
  size: number;
  mtimeMs: number;
}

/** A worktrees root as a path -> node map. `lstat` is the leaf not followed; `remove` unlinks a link, never its target. */
export class MemoryFolders implements ScratchFolders {
  readonly nodes = new Map<string, Node>();
  readonly removed: string[] = [];
  withLstat = true;
  lstat?: (path: FencedPath) => Promise<ScratchLstat | undefined>;

  constructor() {
    this.nodes.set(ROOT, { kind: 'directory', size: 0, mtimeMs: NOW });
    this.lstat = path => this.#lstat(path);
  }

  noLstat(): this {
    this.lstat = undefined;
    return this;
  }
  dir(path: string, mtimeMs = NOW - 100 * HOUR): this {
    this.nodes.set(path, { kind: 'directory', size: 0, mtimeMs });
    return this;
  }
  file(path: string, size: number, mtimeMs = NOW - 100 * HOUR): this {
    this.nodes.set(path, { kind: 'file', size, mtimeMs });
    return this;
  }
  link(path: string, mtimeMs = NOW - 100 * HOUR): this {
    this.nodes.set(path, { kind: 'symlink', size: 0, mtimeMs });
    return this;
  }

  resolve(relative: string) {
    if (relative.includes('..') || relative.includes('\0')) return err('outside' as const);
    const full = relative === '' ? ROOT : relative.startsWith('/') ? relative : `${ROOT}/${relative}`;
    return full === ROOT || full.startsWith(`${ROOT}/`) ? ok(full as FencedPath) : err('outside' as const);
  }
  async list(path: FencedPath): Promise<readonly string[]> {
    const prefix = `${path}/`;
    return [...this.nodes.keys()]
      .filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .map(key => key.slice(prefix.length))
      .sort();
  }
  async remove(path: FencedPath): Promise<void> {
    if (this.nodes.get(path)?.kind === 'symlink') throw new Error('the real root follows a link: never asked');
    this.removed.push(path);
    for (const key of [...this.nodes.keys()]) if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
  }
  async #lstat(path: FencedPath): Promise<ScratchLstat | undefined> {
    const node = this.nodes.get(path);
    return node === undefined ? undefined : { kind: node.kind, size: node.size, modified: at(node.mtimeMs) };
  }
}
