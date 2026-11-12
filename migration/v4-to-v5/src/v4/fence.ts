/**
 * The fence: ONE look at the v4 tree's own folders before any step runs. A folder that is a link (or not a folder) is
 * never descended into: v4 kept `store: host` logins as links out to the terminal's own sign-in folders, and a link
 * in `fleet`, `fleet/credentials` or `fleet/assets` could lead a step the same way. `lstat` only: the entry is looked
 * at, never what it points to, so the target is not even named.
 *
 * Folders are listed parent first. A folder below a fenced one is never `lstat`ed (that call would resolve through the
 * link), it is simply covered by its parent.
 */
import { lstat, readdir } from 'node:fs/promises';
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

/** The v4 home's own single entries preflight reads (a marker, a lock, a v5 sign): each must not be a link. */
export const FENCED_ENTRIES: readonly string[] = ['home.json', 'layout-version', 'daemon.lock'];

/**
 * The fence ENFORCED: one plain sentence per fenced folder that is a link or not a folder, and per entry that is a link,
 * each with the remedy and never the target. Empty when the home is safe to read. `lstat` only, before anything else in the
 * home is looked at, so a refused conversion has made no resolving call on any of them.
 */
export async function fenceProblems(home: string): Promise<readonly string[]> {
  const problems: string[] = [];
  for (const entry of FENCED_ENTRIES) {
    const facts = await lstat(join(home, entry)).catch(() => undefined);
    if (facts?.isSymbolicLink() === true) {
      problems.push(
        `${join(home, entry)} is a link, so the conversion did not start: replace it with the real file, then run again`,
      );
    }
  }
  const fenced = await fenceV4(home);
  for (const folder of fenced) {
    problems.push(
      `${join(home, folder)} is a link or not a folder, so the conversion did not start: replace it with the real folder, then run again`,
    );
  }
  // ANY link inside a fenced tree refuses too: a reader that met one would resolve it. The three roots cover every other fenced folder.
  for (const root of WALKED_ROOTS) {
    if (isFenced(fenced, root)) continue;
    for (const link of await linksUnder(join(home, root))) {
      problems.push(
        `${link} is a link, so the conversion did not start: replace it with the real file or folder, then run again`,
      );
    }
  }
  return problems;
}

/** The roots whose whole trees are searched for links (every other fenced folder is inside `fleet`). */
const WALKED_ROOTS: readonly string[] = ['config', 'state', 'fleet'];

/** Every link entry under `folder` (never followed: only real folders are entered, entries are read by type). */
async function linksUnder(folder: string): Promise<readonly string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink()) found.push(path);
    else if (entry.isDirectory()) found.push(...(await linksUnder(path)));
  }
  return found;
}

/** Whether `folder` or any folder above it is fenced. */
export function isFenced(fenced: ReadonlySet<string>, folder: string): boolean {
  const parts = folder.split('/');
  return parts.some((_, index) => fenced.has(parts.slice(0, index + 1).join('/')));
}

/** What a step asks: is this v4 folder (or one above it) fenced? Absent fence (a test's bare paths): nothing is. */
export const v4Fenced = (v4: V4Paths, folder: string): boolean => isFenced(v4.fenced ?? new Set(), folder);
