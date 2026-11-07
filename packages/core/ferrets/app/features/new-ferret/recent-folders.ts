/**
 * THE FOLDERS A FERRET WAS RECENTLY STARTED IN, as the Folder box offers them. Pure, except `readRecentFolders`.
 *
 * Today's Project box offered two kinds of row: folders the daemon had registered as projects, then folders sessions had
 * merely used. The registry is the Projects plugin's and Ferrets reaches it through no contract, so this box offers the
 * second kind alone: the folder of every ferret on the daemon, newest first, each once. Choosing a row only types a path;
 * nothing is registered. A failed read is a status here, never a throw that would take the form down with it.
 */

import type { PickerOption, PickerSource } from '@ferretry/app/ui';
import { z } from 'zod';
import type { FerretsClient } from '../../lib/client.ts';

/** The two fields of a ferret's summary this box reads; the rest of the record is not its business. */
const FolderOfFerretSchema = z.object({ folder: z.string().min(1), stateAt: z.string().min(1) });

export interface RecentFolder {
  readonly path: string;
  readonly lastActivity: string;
}

/** A folder without its trailing slashes, so `/work/a/` and `/work/a` are one row. The root stays `/`. */
export const normalizeFolder = (path: string): string => {
  const trimmed = path.replace(/\/+$/u, '');
  return trimmed === '' ? path : trimmed;
};

export const folderBaseName = (path: string): string => {
  const segments = path.split('/').filter(Boolean);
  return segments.length > 0 ? (segments[segments.length - 1] as string) : path;
};

/** Recently used folders, newest first and deduplicated by path. A record that is not a ferret's summary is skipped. */
export const recentFolders = (list: readonly unknown[]): readonly RecentFolder[] => {
  const newest = new Map<string, string>();
  for (const item of list) {
    const parsed = FolderOfFerretSchema.safeParse(item);
    if (!parsed.success) continue;
    const path = normalizeFolder(parsed.data.folder.trim());
    if (path === '') continue;
    const previous = newest.get(path);
    if (previous === undefined || Date.parse(parsed.data.stateAt) > Date.parse(previous))
      newest.set(path, parsed.data.stateAt);
  }
  return [...newest.entries()]
    .map(([path, lastActivity]) => ({ path, lastActivity }))
    .sort((left, right) => {
      const recency = Date.parse(right.lastActivity) - Date.parse(left.lastActivity);
      return recency === 0 ? left.path.localeCompare(right.path) : recency;
    });
};

export interface FolderOption extends PickerOption {
  readonly name: string;
}

export const folderOptions = (folders: readonly RecentFolder[]): readonly FolderOption[] =>
  folders.map(folder => {
    const name = folderBaseName(folder.path);
    return {
      value: folder.path,
      label: name,
      name,
      search: [name, folder.path, 'recent'].join(' ').toLowerCase(),
      detail: folder.path,
    };
  });

/** What the folder read has produced so far. `folders: null` means unread. */
export interface FolderRead {
  readonly status: 'loading' | 'ready' | 'error';
  readonly folders: readonly RecentFolder[] | null;
  readonly error: string | null;
}

export const LOADING_FOLDERS: FolderRead = { status: 'loading', folders: null, error: null };

/**
 * The read as the combobox's source. WHAT DECIDES IS THE STATUS: rows that are present cannot answer whether the last
 * refresh worked, and absent rows cannot tell a read in flight from one that refused.
 */
export const folderSource = (read: FolderRead): PickerSource<FolderOption> => {
  if (read.folders === null) {
    return read.status === 'error'
      ? { kind: 'failed', reason: read.error ?? 'this daemon’s folders could not be read' }
      : { kind: 'loading' };
  }
  const stale =
    read.status === 'error'
      ? (read.error ?? 'the ferret list could not be refreshed — the recently used folders may be out of date')
      : null;
  return { kind: 'ready', options: folderOptions(read.folders), ...(stale === null ? {} : { staleReason: stale }) };
};

/** One read of the daemon's ferrets, narrowed to their folders. */
export async function readRecentFolders(client: FerretsClient): Promise<readonly RecentFolder[]> {
  const answer = await client.call<unknown>('GET /v1/ferrets');
  if (!Array.isArray(answer))
    throw new Error('the daemon answered the ferret list with something this page cannot read');
  return recentFolders(answer);
}
