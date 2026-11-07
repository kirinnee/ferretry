import { err, ok, type Result } from '@ferretry/std';
import type { FencedPath, FerretId, FolderRefusal, WorkFolders } from '../../../contract/index.ts';
import type { FerretRegistry } from '../registry/registry.ts';

/**
 * WHICH FOLDER A FERRET MAY WORK IN (§2.2, §7.7): the one it was started in. Synchronous and memory-only, as the
 * kernel asks it. This is the lexical half of today's session file gates (gate 1, `path-policy.ts`): it refuses an
 * unknown ferret, a path with a NUL, and anything that leaves the folder after `.`/`..` are resolved. The fence
 * (the daemon's home), symlinks, hard links and device files are the kernel root handle's checks, made on the real
 * file when it is opened (§7.7), because a check on names cannot see a link.
 */

/** `/a/./b/../c` → `/a/c`; `undefined` when `..` climbs past the root. Paths use `/`. */
export function normalizeAbsolute(path: string): string | undefined {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

/** Whether `path` is `folder` or inside it. Both normalized absolute paths. */
export function withinFolder(folder: string, path: string): boolean {
  const base = folder === '/' ? '' : folder;
  return path === folder || path.startsWith(`${base}/`);
}

export class RegistryWorkFolders implements WorkFolders {
  constructor(private readonly registry: FerretRegistry) {}

  folderOf(ferret: FerretId): FencedPath | undefined {
    const folder = this.registry.get(ferret)?.folder;
    if (folder === undefined) return undefined;
    return (normalizeAbsolute(folder) ?? folder) as FencedPath;
  }

  check(ferret: FerretId, path: string): Result<FencedPath, FolderRefusal> {
    const folder = this.folderOf(ferret);
    if (folder === undefined) return err('unknown_ferret');
    if (path.includes('\u0000')) return err('outside');
    const absolute = path.startsWith('/') ? path : `${folder}/${path}`;
    const normalized = normalizeAbsolute(absolute);
    if (normalized === undefined || !withinFolder(folder, normalized)) return err('outside');
    return ok(normalized as FencedPath);
  }
}
