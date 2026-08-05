import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  SharedHistoryFileSystem,
  SharedHistoryNode,
  SharedHistorySymbolicLinkNode,
} from '../lib/shared-history.ts';

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Real filesystem primitives for the shared-history planner.
 *
 * Every path is lexically confined to a root supplied by the composition root. `snapshot` uses
 * lstat and never follows a symbolic link: a foreign link is evidence to preserve, not an empty
 * directory to replace. Only ENOENT means absent; permission, truncation and type failures refuse
 * the migration.
 */
export class FileSharedHistoryFileSystem implements SharedHistoryFileSystem {
  private readonly allowedRoots: readonly string[];

  constructor(allowedRoots: readonly string[]) {
    if (allowedRoots.length === 0) throw new Error('at least one allowed shared-history root is required');
    this.allowedRoots = allowedRoots.map(root => path.resolve(root));
  }

  async snapshot(
    target: string,
    options: { readonly readText?: boolean; readonly recursive?: boolean } = {},
  ): Promise<SharedHistoryNode | undefined> {
    this.assertAllowedPath(target);
    let information: Stats;
    try {
      information = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (information.isSymbolicLink()) {
      return {
        kind: 'symbolic-link',
        modifiedAtMs: information.mtimeMs,
        target: await readlink(target),
      } satisfies SharedHistorySymbolicLinkNode;
    }
    if (information.isFile()) {
      return {
        kind: 'file',
        modifiedAtMs: information.mtimeMs,
        size: information.size,
        ...(options.readText ? { text: await readFile(target, 'utf8') } : {}),
      };
    }
    if (!information.isDirectory()) return { kind: 'other', modifiedAtMs: information.mtimeMs };

    const children: Record<string, SharedHistoryNode> = {};
    if (options.recursive === false) {
      return { kind: 'directory', modifiedAtMs: information.mtimeMs, children };
    }
    for (const name of (await readdir(target)).toSorted()) {
      const childPath = path.join(target, name);
      const child = await this.snapshot(childPath);
      if (child === undefined) {
        throw new Error(`shared-history entry disappeared while it was being read: ${childPath}`);
      }
      children[name] = child;
    }
    return { kind: 'directory', modifiedAtMs: information.mtimeMs, children };
  }

  async ensureDirectory(target: string): Promise<boolean> {
    this.assertAllowedPath(target);
    const existing = await this.snapshot(target);
    if (existing !== undefined) {
      if (existing.kind !== 'directory') {
        throw new Error(`shared-history directory path is ${existing.kind}: ${target}`);
      }
      return false;
    }
    await mkdir(target, { recursive: true, mode: 0o700 });
    const created = await this.snapshot(target);
    if (created?.kind !== 'directory') throw new Error(`could not create shared-history directory: ${target}`);
    return true;
  }

  async ensureFile(target: string): Promise<boolean> {
    this.assertAllowedPath(target);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    let handle: FileHandle;
    try {
      handle = await open(target, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.snapshot(target);
      if (existing?.kind !== 'file') {
        throw new Error(`shared-history file path is ${existing?.kind ?? 'absent'}: ${target}`);
      }
      return false;
    }
    await handle.close();
    return true;
  }

  async move(source: string, destination: string): Promise<void> {
    this.assertAllowedPath(source);
    this.assertAllowedPath(destination);
    if ((await this.snapshot(source)) === undefined) throw new Error(`shared-history move source is absent: ${source}`);
    if ((await this.snapshot(destination)) !== undefined) {
      throw new Error(`shared-history move destination already exists: ${destination}`);
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await rename(source, destination);
  }

  async writeTextAtomic(target: string, text: string): Promise<void> {
    this.assertAllowedPath(target);
    const existing = await this.snapshot(target);
    if (existing !== undefined && existing.kind !== 'file') {
      throw new Error(`shared-history text path is ${existing.kind}: ${target}`);
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async createSymbolicLink(target: string, destination: string): Promise<void> {
    this.assertAllowedPath(target);
    this.assertAllowedPath(destination);
    if ((await this.snapshot(target)) === undefined) {
      throw new Error(`refusing to create a dangling shared-history link: ${destination} -> ${target}`);
    }
    if ((await this.snapshot(destination)) !== undefined) {
      throw new Error(`shared-history link destination already exists: ${destination}`);
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await symlink(target, destination);
  }

  async removeSymbolicLink(target: string, expectedTarget: string): Promise<void> {
    this.assertAllowedPath(target);
    const existing = await this.snapshot(target);
    if (existing?.kind !== 'symbolic-link') {
      throw new Error(`shared-history rollback expected a symbolic link: ${target}`);
    }
    if (path.resolve(path.dirname(target), existing.target) !== path.resolve(expectedTarget)) {
      throw new Error(`shared-history rollback refused a replaced symbolic link: ${target}`);
    }
    await rm(target);
  }

  async removeEmptyDirectory(target: string): Promise<void> {
    this.assertAllowedPath(target);
    const existing = await this.snapshot(target);
    if (existing?.kind !== 'directory') {
      throw new Error(`shared-history cleanup expected a directory: ${target}`);
    }
    await rmdir(target);
  }

  async removeFile(target: string): Promise<void> {
    this.assertAllowedPath(target);
    const existing = await this.snapshot(target);
    if (existing?.kind !== 'file') throw new Error(`shared-history cleanup expected a file: ${target}`);
    await rm(target);
  }

  private assertAllowedPath(target: string): void {
    if (!path.isAbsolute(target)) throw new Error(`shared-history path must be absolute: ${target}`);
    const resolved = path.resolve(target);
    const allowed = this.allowedRoots.some(root => {
      if (resolved === root) return true;
      const fromRoot = path.relative(root, resolved);
      return fromRoot.length > 0 && !fromRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(fromRoot);
    });
    if (!allowed) throw new Error(`refusing shared-history access outside configured roots: ${target}`);
  }
}
