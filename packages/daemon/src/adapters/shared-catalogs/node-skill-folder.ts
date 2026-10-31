import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type {
  SkillFileRead,
  SkillWalkLimits,
  SkillTreeEntry,
  SkillTreeListing,
  SkillTreePort,
} from '../../lib/shared-catalogs/skill-source.ts';

const isInside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
};

/**
 * A skill folder read straight off the disk, never through a link.
 *
 * The folder itself is resolved once (the fleet links a skill into a runtime home, so the inventory's path
 * may name a link to the folder). Everything INSIDE it is looked at with `lstat` and reported as it is: a
 * symbolic link is listed and left alone, never entered, so a skill cannot make the publisher read a file
 * outside its folder. A read opens with `O_NOFOLLOW` and checks the parent still resolves inside the
 * folder, because a folder can change between the listing and the read.
 */
export class NodeSkillFolder implements SkillTreePort {
  async list(manifestPath: string, limits: SkillWalkLimits): Promise<SkillTreeListing | undefined> {
    let root: string;
    try {
      root = await realpath(dirname(manifestPath));
    } catch {
      return undefined;
    }
    const entries: SkillTreeEntry[] = [];
    let truncated = false;
    const pending: { readonly directory: string; readonly prefix: readonly string[] }[] = [
      { directory: root, prefix: [] },
    ];
    for (const next of pending) {
      if (truncated) break;
      let names: string[];
      try {
        names = (await readdir(next.directory)).toSorted();
      } catch {
        if (next.prefix.length === 0) return undefined;
        entries.push({ path: next.prefix.join('/'), type: 'other', size: 0 });
        continue;
      }
      for (const name of names) {
        if (entries.length >= limits.entries) {
          truncated = true;
          break;
        }
        const segments = [...next.prefix, name];
        const path = segments.join('/');
        const full = join(next.directory, name);
        let stats: Awaited<ReturnType<typeof lstat>>;
        try {
          stats = await lstat(full);
        } catch {
          entries.push({ path, type: 'other', size: 0 });
          continue;
        }
        if (stats.isSymbolicLink()) entries.push({ path, type: 'symlink', size: 0 });
        else if (stats.isDirectory()) {
          if (segments.length >= limits.depth) entries.push({ path, type: 'deep', size: 0 });
          else pending.push({ directory: full, prefix: segments });
        } else if (stats.isFile()) entries.push({ path, type: 'file', size: stats.size });
        else entries.push({ path, type: 'other', size: 0 });
      }
    }
    return { entries, truncated };
  }

  async read(manifestPath: string, relativePath: string, maxBytes: number): Promise<SkillFileRead> {
    try {
      const root = await realpath(dirname(manifestPath));
      const target = join(root, ...relativePath.split('/'));
      if (!isInside(root, target) || relativePath.split('/').includes('..')) return { ok: false, reason: 'unreadable' };
      const parent = await realpath(dirname(target));
      if (parent !== root && !isInside(root, parent)) return { ok: false, reason: 'unreadable' };
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const buffer = new Uint8Array(maxBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
        if (bytesRead > maxBytes) return { ok: false, reason: 'too_big' };
        return { ok: true, bytes: buffer.slice(0, bytesRead) };
      } finally {
        await handle.close();
      }
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }
}
