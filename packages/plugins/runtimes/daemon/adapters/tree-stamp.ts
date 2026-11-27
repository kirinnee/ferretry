/**
 * One short fingerprint of a whole folder, so a runtime home can tell "the folder Ferretry copied" from "that folder with
 * something of the person's in it". A recorded folder NAME proves nothing about what is inside it today.
 *
 * What counts is the shape and the content: every name below the folder, its kind, a file's bytes, a link's size, and a
 * file's permission bits. Times are left out on purpose: a touched but unchanged file is not an edit. A folder this
 * cannot summarise whole (too many entries, a file too large or unreadable) has NO stamp, and a folder with no stamp is
 * never provably Ferretry's, so it is kept.
 */
import { createHash } from 'node:crypto';
import type { FleetDisk } from './fleet-disk.ts';

/** How many entries one folder may hold before it is too big to vouch for. A bound on work. */
const MAX_STAMPED_ENTRIES = 20_000;
/** The largest file read whole into the stamp. */
const MAX_STAMPED_FILE_BYTES = 4 * 1024 * 1024;
const PERMISSION_BITS = 0o777;

/** The stamp of the folder at `directory`, or `undefined` when it cannot be summarised whole. */
export async function stampTree(disk: FleetDisk, directory: string): Promise<string | undefined> {
  const hasher = createHash('sha256');
  const budget = { left: MAX_STAMPED_ENTRIES };
  try {
    if (!(await fold(disk, directory, '', hasher, budget))) return undefined;
  } catch {
    return undefined;
  }
  return hasher.digest('hex');
}

/** Folds everything under `directory` into `hasher`; `false` when the work bound was reached. */
async function fold(
  disk: FleetDisk,
  directory: string,
  prefix: string,
  hasher: ReturnType<typeof createHash>,
  budget: { left: number },
): Promise<boolean> {
  const found = await disk.entries(directory);
  for (const entry of found.toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if (budget.left <= 0) return false;
    budget.left -= 1;
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const full = `${directory}/${entry.name}`;
    if (entry.kind === 'directory') {
      hasher.update(`d ${relative}\n`);
      if (!(await fold(disk, full, relative, hasher, budget))) return false;
    } else if (entry.kind === 'file') {
      const bytes = await disk.readBytes(full, MAX_STAMPED_FILE_BYTES);
      const digest = createHash('sha256').update(bytes).digest('hex');
      hasher.update(`f ${relative} ${entry.mode & PERMISSION_BITS} ${digest}\n`);
    } else {
      hasher.update(`${entry.kind} ${relative} ${entry.size}\n`);
    }
  }
  return true;
}
