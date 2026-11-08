/**
 * The files a machine's setup reads (docs/design/account-model.md §4.3, §4.7): the person's own
 * harness setup, folders read as text, and the asset tree's skill items.
 *
 * Reads only: every write the setup service makes goes through the provisioner, inside its rollback
 * boundary.
 */

import { join } from 'node:path';
import type { FolderReading } from '../lib/service/setup-service.ts';

import type { HostFiles } from './ports.ts';

/** The largest file a folder read carries; a larger one is skipped and named. */
const MAX_FOLDER_FILE_BYTES = 256 * 1024;
/** The most files one folder read takes; the rest are skipped and named. */
export const MAX_FOLDER_FILES = 500;

/** Names a folder read never enters: version control and the harness's own bundled skills. */
const SKIPPED_ENTRIES: ReadonlySet<string> = new Set(['.git', '.system', 'node_modules']);

/**
 * One folder, every regular file in it read as UTF-8 text, relative to the folder. A link, a file
 * that is not text or is too large, and anything past the file limit is skipped with the reason,
 * never followed and never truncated. A folder that does not exist reads as empty.
 */
export async function readTextFolder(
  files: Pick<HostFiles, 'lstat' | 'list' | 'readBytes'>,
  root: string,
): Promise<FolderReading> {
  const found: { path: string; content: string }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const walk = async (relative: string): Promise<void> => {
    const names = await files.list(join(root, relative));
    if (names === undefined) return;
    for (const name of names.toSorted()) {
      if (SKIPPED_ENTRIES.has(name)) continue;
      const path = relative === '' ? name : `${relative}/${name}`;
      const entry = await files.lstat(join(root, path));
      if (entry === undefined) continue;
      if (entry.kind === 'directory') {
        await walk(path);
        continue;
      }
      if (entry.kind !== 'file') {
        skipped.push({ path, reason: 'it is a link or a special file' });
        continue;
      }
      if (found.length >= MAX_FOLDER_FILES) {
        skipped.push({ path, reason: 'the folder has too many files' });
        continue;
      }
      if (entry.size > MAX_FOLDER_FILE_BYTES) {
        skipped.push({ path, reason: 'it is too large' });
        continue;
      }
      try {
        const bytes = await files.readBytes(join(root, path));
        if (bytes === undefined) continue;
        found.push({ path, content: decoder.decode(bytes) });
      } catch {
        skipped.push({ path, reason: 'it is not text' });
      }
    }
  };
  await walk('');
  return { files: found, skipped };
}

/** The skill items a skills store holds: one folder per item. Absent reads as none. */
export async function skillItemsIn(
  files: Pick<HostFiles, 'lstat' | 'list'>,
  directory: string,
): Promise<readonly string[]> {
  const names = await files.list(directory);
  if (names === undefined) return [];
  const items: string[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if ((await files.lstat(join(directory, name)))?.kind === 'directory') items.push(name);
  }
  return items.toSorted();
}
