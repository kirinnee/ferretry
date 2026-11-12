/**
 * The fence: ONE look at the v4 tree's own folders before any step runs. A folder that is a link (or not a folder) is
 * never descended into: v4 kept `store: host` logins as links out to the terminal's own sign-in folders, and a link
 * in `fleet`, `fleet/credentials` or `fleet/assets` could lead a step the same way. `lstat` only: the entry is looked
 * at, never what it points to, so the target is not even named.
 *
 * Folders are listed parent first. A folder below a fenced one is never `lstat`ed (that call would resolve through the
 * link), it is simply covered by its parent.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { V4Paths } from './layout.ts';

/** The v4 folders the steps descend into (relative to the v4 home), parent first. */
export const FENCED_FOLDERS: readonly string[] = [
  'config',
  'state',
  'fleet',
  'fleet/credentials',
  'fleet/assets',
  'fleet/homes',
  'fleet/shared',
  'fleet/bin',
];

/** The relative folders (of {@link FENCED_FOLDERS}) that are present and not a real folder. */
export async function fenceV4(home: string): Promise<ReadonlySet<string>> {
  const fenced = new Set<string>();
  for (const folder of FENCED_FOLDERS) {
    if (isFenced(fenced, folder)) continue;
    const facts = await lstat(join(home, folder)).catch((error: NodeJS.ErrnoException) =>
      error.code === 'ENOENT' ? null : undefined,
    );
    if (facts === null) continue;
    // Cannot be inspected: fail closed, as a link.
    if (facts === undefined || !facts.isDirectory()) fenced.add(folder);
  }
  return fenced;
}

/** Whether `folder` or any folder above it is fenced. */
export function isFenced(fenced: ReadonlySet<string>, folder: string): boolean {
  const parts = folder.split('/');
  return parts.some((_, index) => fenced.has(parts.slice(0, index + 1).join('/')));
}

/** What a step asks: is this v4 folder (or one above it) fenced? Absent fence (a test's bare paths): nothing is. */
export const v4Fenced = (v4: V4Paths, folder: string): boolean => isFenced(v4.fenced ?? new Set(), folder);
