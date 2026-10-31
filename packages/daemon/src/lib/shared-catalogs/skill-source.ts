/**
 * A skill folder on this machine, turned into the files a catalog carries. Pure: a port lists and reads.
 *
 * NOTHING IS SKIPPED SILENTLY. Every entry the walk found is either carried or listed with the reason it
 * is not — a symbolic link (never followed: it could point out of the folder), a file that is not text, a
 * file over 256 KiB, a name the contract refuses (`.git`, a space, a non-ASCII letter), a path that would
 * be the same file as another on a Mac or on Windows, and what is left over once the 200-file or 2 MiB
 * bound is reached. The person reads that list in the preview, beside the files themselves.
 *
 * The walk is bounded BEFORE any content is read: the port stops listing at {@link SKILL_WALK_LIMITS}, and
 * only files whose listed size fits are opened.
 */
import {
  CATALOG_SKILL_ENTRY_FILE,
  CATALOG_SKILL_FILE_MAX_BYTES,
  CATALOG_SKILL_MAX_BYTES,
  CATALOG_SKILL_MAX_FILES,
  CatalogSkillFileSchema,
  type CatalogSkillFile,
  type CatalogSourceProblem,
  revealHidden,
} from '@ferretry/protocol';

/** How far a walk goes. Past it the listing says it was cut short. */
export interface SkillWalkLimits {
  readonly entries: number;
  readonly depth: number;
}

export const SKILL_WALK_LIMITS: SkillWalkLimits = { entries: 1_000, depth: 16 };

type SkillTreeEntryType = 'file' | 'symlink' | 'other' | 'deep';

/** One thing found in the skill folder. `path` is relative, `/`-separated. A `deep` entry is a folder not entered. */
export interface SkillTreeEntry {
  readonly path: string;
  readonly type: SkillTreeEntryType;
  /** Bytes, as listed. Zero for anything that is not a file. */
  readonly size: number;
}

export interface SkillTreeListing {
  readonly entries: readonly SkillTreeEntry[];
  /** The walk stopped at the entry limit: there is more it did not look at. */
  readonly truncated: boolean;
}

export type SkillFileRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'too_big' | 'unreadable' };

/** The folder of a skill, by the SKILL.md path the skills inventory lists. */
export interface SkillTreePort {
  list(manifestPath: string, limits: SkillWalkLimits): Promise<SkillTreeListing | undefined>;
  read(manifestPath: string, relativePath: string, maxBytes: number): Promise<SkillFileRead>;
}

export interface FrozenSkillFiles {
  /** Present unless SKILL.md itself could not be carried (then `refusal` says why). */
  readonly files: readonly CatalogSkillFile[];
  readonly problems: readonly CatalogSourceProblem[];
  readonly refusal?: string;
}

const strictText = new TextDecoder('utf-8', { fatal: true });

/** The text of a file, or why it is not text. */
function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return strictText.decode(bytes);
  } catch {
    return undefined;
  }
}

const subject = (path: string): string => revealHidden(path).slice(0, 512) || '(unnamed)';

/** Why the contract would refuse this path, or `null` when it would carry it. */
function pathProblem(path: string): string | null {
  const parsed = CatalogSkillFileSchema.shape.path.safeParse(path);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'its path is not one a skill carries');
}

export async function readSkillFolder(port: SkillTreePort, manifestPath: string): Promise<FrozenSkillFiles> {
  const listing = await port.list(manifestPath, SKILL_WALK_LIMITS);
  if (listing === undefined)
    return {
      files: [],
      problems: [],
      refusal: 'The skill folder cannot be read any more. It may have been moved or deleted.',
    };
  const problems: CatalogSourceProblem[] = [];
  const skip = (path: string, reason: string) => problems.push({ subject: subject(path), reason });
  const files: CatalogSkillFile[] = [];
  const taken = new Map<string, string>();
  let total = 0;

  for (const entry of listing.entries.toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    if (entry.type === 'symlink') {
      skip(entry.path, 'a symbolic link, which is never followed: it could point out of the folder');
      continue;
    }
    if (entry.type === 'other') {
      skip(entry.path, 'not a regular file (a socket, a device or a pipe)');
      continue;
    }
    if (entry.type === 'deep') {
      skip(entry.path, `a folder nested deeper than ${SKILL_WALK_LIMITS.depth} levels, so nothing in it was looked at`);
      continue;
    }
    const refused = pathProblem(entry.path);
    if (refused !== null) {
      skip(entry.path, `its name is not one a catalog carries: ${refused}`);
      continue;
    }
    const lower = entry.path.toLowerCase();
    const earlier = taken.get(lower);
    if (earlier !== undefined) {
      skip(entry.path, `it would be the same file as ${earlier} on a Mac or on Windows`);
      continue;
    }
    if (entry.size > CATALOG_SKILL_FILE_MAX_BYTES) {
      skip(entry.path, `larger than ${CATALOG_SKILL_FILE_MAX_BYTES / 1024} KiB`);
      continue;
    }
    if (files.length >= CATALOG_SKILL_MAX_FILES) {
      skip(entry.path, `a skill carries at most ${CATALOG_SKILL_MAX_FILES} files`);
      continue;
    }
    if (total + entry.size > CATALOG_SKILL_MAX_BYTES) {
      skip(entry.path, `it would take the skill past ${CATALOG_SKILL_MAX_BYTES / 1024 / 1024} MiB in total`);
      continue;
    }
    const read = await port.read(manifestPath, entry.path, CATALOG_SKILL_FILE_MAX_BYTES);
    if (!read.ok) {
      skip(
        entry.path,
        read.reason === 'too_big' ? `larger than ${CATALOG_SKILL_FILE_MAX_BYTES / 1024} KiB` : 'it could not be read',
      );
      continue;
    }
    const content = textOf(read.bytes);
    if (content === undefined) {
      skip(entry.path, 'not text (a binary file, or not UTF-8)');
      continue;
    }
    taken.set(lower, entry.path);
    total += read.bytes.length;
    files.push({ path: entry.path, content });
  }
  if (listing.truncated)
    problems.push({
      subject: '(the rest of the folder)',
      reason: `the folder holds more than ${SKILL_WALK_LIMITS.entries} entries, so the rest were not looked at`,
    });
  if (!files.some(file => file.path === CATALOG_SKILL_ENTRY_FILE)) {
    const why =
      problems.find(problem => problem.subject === CATALOG_SKILL_ENTRY_FILE)?.reason ?? 'it is not in the folder';
    return { files, problems, refusal: `${CATALOG_SKILL_ENTRY_FILE} cannot be carried: ${why}.` };
  }
  return { files, problems };
}
