import { lstat, readdir } from 'node:fs/promises';
import type { Inspected } from './credential-check.ts';

/**
 * What a path IS, for the credential check's emptiness proof: `lstat`, never `stat`, so a symlink is `other` (the check
 * refuses it) however empty and private its target is. A folder also gives the NAMES of its entries, never a content.
 * `undefined`: nothing is there.
 */
export async function inspectPath(path: string): Promise<Inspected | undefined> {
  const seen = await lstat(path).catch(() => undefined);
  if (seen === undefined) return undefined;
  const names = seen.isDirectory() ? await readdir(path) : [];
  return {
    kind: seen.isDirectory() ? 'dir' : seen.isFile() ? 'file' : 'other',
    mode: seen.mode & 0o777,
    size: seen.size,
    entries: names.length,
    names,
  };
}
