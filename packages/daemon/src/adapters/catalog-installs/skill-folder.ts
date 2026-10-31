/**
 * A skill folder on disk, shared by the project writer and the runtime store's pruner. Both obey the same rules:
 *
 * NEVER THROUGH A LINK. Every directory from the root down to the folder is `lstat`ed and refused if it is a
 * symbolic link; every file is opened `O_NOFOLLOW`; the temporary file is `O_EXCL` beside its target. Anything
 * that is not a plain file or a plain directory inside the folder is refused, not skipped, so an install can
 * never claim a folder it only half understood.
 *
 * COMPARE, THEN SWAP. Every touched path is re-hashed just before it is written or deleted and must still be
 * what the person's review showed. DECLARED GAP: a directory swapped for a link between that check and the
 * write is not caught (a directory has no atomic compare-and-swap); the file rules above hold at every open.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  SkillFolderChanged,
  type SkillFolderChange,
  type SkillFolderReading,
  SkillFolderRefused,
} from '../../lib/catalog-installs/ports.ts';

/** More than a skill is: a folder past either limit is refused, not read. */
export const MAX_SKILL_FOLDER_FILES = 64;
export const MAX_SKILL_FOLDER_BYTES = 4 * 1024 * 1024;

const NEW_FILE_MODE = 0o644;
const NEW_DIRECTORY_MODE = 0o755;

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

/** The state of one path component: absent, a plain directory, or refused. */
async function plainDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new SkillFolderRefused(
        `${path} is a symbolic link, and Ferretry will not follow it. Replace it with the folder itself.`,
      );
    if (!info.isDirectory()) throw new SkillFolderRefused(`${path} is not a folder, so a skill cannot go there.`);
    return true;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw error;
  }
}

/** Every component of `folder` under `root`, in order, each checked. `false` when the folder does not exist yet. */
async function checkedFolder(
  root: string,
  folder: string,
): Promise<{ readonly absolute: string; readonly exists: boolean }> {
  let current = root;
  for (const part of folder.split('/')) {
    current = join(current, part);
    if (!(await plainDirectory(current))) return { absolute: join(root, folder), exists: false };
  }
  return { absolute: current, exists: true };
}

/** Opening a link with O_NOFOLLOW fails ELOOP (EMLINK on some systems); a socket fails ENXIO. */
const NOT_PLAIN_OPEN_CODES = new Set(['ELOOP', 'EMLINK', 'ENXIO']);

async function readPlainFile(path: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    (error: unknown) => Promise.reject(NOT_PLAIN_OPEN_CODES.has(codeOf(error) ?? '') ? notPlain(path) : error),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notPlain(path);
    if (info.size > MAX_SKILL_FOLDER_BYTES) throw new SkillFolderRefused(`${path} is larger than a skill file can be.`);
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

const notPlain = (path: string): SkillFolderRefused =>
  new SkillFolderRefused(`${path} is not a plain file (a link or a special file), so Ferretry will not read it.`);

/** Every file below `directory` as relative path → hash. */
async function readTree(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let total = 0;
  const walk = async (absolute: string, relative: string): Promise<void> => {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const path = join(absolute, entry.name);
      if (entry.isDirectory()) await walk(path, next);
      else {
        const bytes = await readPlainFile(path);
        total += bytes.byteLength;
        if (files.size >= MAX_SKILL_FOLDER_FILES || total > MAX_SKILL_FOLDER_BYTES)
          throw new SkillFolderRefused(`${directory} holds more than a skill can, so Ferretry left it alone.`);
        files.set(next, sha256(bytes));
      }
    }
  };
  await walk(directory, '');
  return files;
}

export async function inspectSkillFolder(root: string, folder: string): Promise<SkillFolderReading> {
  const checked = await checkedFolder(root, folder);
  return checked.exists
    ? { exists: true, files: await readTree(checked.absolute) }
    : { exists: false, files: new Map() };
}

/** Create `absolute` and any missing parents under `base`, refusing a link at each step. */
async function ensureDirectories(base: string, absolute: string): Promise<void> {
  const relative = absolute
    .slice(base.length)
    .split('/')
    .filter(part => part !== '');
  let current = base;
  for (const part of relative) {
    current = join(current, part);
    if (await plainDirectory(current)) continue;
    await mkdir(current, { mode: NEW_DIRECTORY_MODE });
  }
}

/** `lstat`, so a link is not a directory; a path that is gone is not either. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Remove empty directories from `start` up to and including `stop`, stopping at the first that is not empty. */
async function pruneEmpty(start: string, stop: string): Promise<void> {
  let current = start;
  for (;;) {
    if ((await readdir(current)).length > 0) return;
    await rmdir(current);
    if (current === stop) return;
    current = dirname(current);
  }
}

export async function applySkillFolder(
  root: string,
  folder: string,
  change: SkillFolderChange,
  uniqueId: () => string = randomUUID,
): Promise<void> {
  const checked = await checkedFolder(root, folder);
  const hashes = checked.exists ? await readTree(checked.absolute) : new Map<string, string>();
  for (const [path, expected] of change.expected)
    if ((hashes.get(path) ?? null) !== expected) throw new SkillFolderChanged();
  const absolute = checked.absolute;
  await ensureDirectories(root, absolute);
  for (const file of change.write) {
    const target = join(absolute, file.path);
    await ensureDirectories(absolute, dirname(target));
    const temporary = join(dirname(target), `.${uniqueId()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      NEW_FILE_MODE,
    );
    let placed = false;
    try {
      try {
        await handle.chmod(NEW_FILE_MODE);
        await handle.writeFile(new TextEncoder().encode(file.content));
        await handle.sync();
      } finally {
        await handle.close();
      }
      const info = await lstat(target).catch((error: unknown) =>
        codeOf(error) === 'ENOENT' ? undefined : Promise.reject(error),
      );
      if (info !== undefined && !info.isFile())
        throw new SkillFolderRefused(`${target} is not a plain file, so Ferretry will not replace it.`);
      await rename(temporary, target);
      placed = true;
    } finally {
      if (!placed) await rm(temporary, { force: true });
    }
  }
  for (const path of change.remove) await rm(join(absolute, path), { force: true });
  const touched = new Set([
    ...change.write.map(file => dirname(join(absolute, file.path))),
    ...change.remove.map(path => dirname(join(absolute, path))),
  ]);
  for (const directory of touched) {
    if (!(await isDirectory(directory))) continue;
    await pruneEmpty(directory, absolute);
  }
}
