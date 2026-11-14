import type { RootsPort, SharedTree, StatePort } from '@ferretry/kernel/contract';
import { SKILLS_INSTALLED_STATE } from '../../contract/index.ts';

/** The most files, bytes per file and bytes in all that one installed skill holds (the catalogue's own bounds, copied). */
const MAX_INSTALLED_FILES = 200;
export const MAX_INSTALLED_FILE_BYTES = 256 * 1024;
const MAX_INSTALLED_BYTES = 2 * 1024 * 1024;
const MAX_PATH_DEPTH = 16;

/** The file a skill folder is found by. */
const SKILL_ENTRY_FILE = 'SKILL.md';

/**
 * The folder, beside the skills, that remembers which paths a skill was installed with (`_files/<name>`: a JSON list). The
 * state port lists only the top of a tree, so a catalog install (which must find what it wrote, to compare and to remove
 * it) needs the list from here. A skill name starts with a letter or digit (never `_`), and a skill's own files live under its name, so nothing a
 * skill holds can be this folder.
 */
const INDEX_FOLDER = '_files';

/** One folder name: a plain path component a harness can load as a skill (no leading dot, so never `.system`). */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._%~-]{0,100}$/u;

export class InstalledSkillRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstalledSkillRefused';
  }
}

/**
 * An install or removal that would replace or delete something in the folder no install of ours wrote (a file the
 * person added by hand, a link, a folder the store cannot read into). The folder is left exactly as it was, and the
 * message names the path (never its content).
 */
export class InstalledSkillConflict extends InstalledSkillRefused {
  constructor(message: string) {
    super(message);
    this.name = 'InstalledSkillConflict';
  }
}

/** The most entries one look at an installed folder lists before it says there are more than a skill holds. */
const MAX_WALKED_ENTRIES = 1000;

/** One thing found on disk inside an installed skill's folder (a folder only when the walk could not go into it). */
export interface InstalledEntry {
  readonly path: string;
  readonly kind: 'file' | 'symlink' | 'directory';
}

/** One file of a skill to install: a path inside the folder, and its text. */
export interface InstalledSkillFile {
  readonly path: string;
  readonly content: string;
}

/** Whether `name` can be an installed skill's folder. */
export const usableSkillName = (name: string): boolean =>
  SKILL_NAME.test(name) && name !== '..' && !name.includes('..');

/**
 * Why a set of paths cannot be written as one folder, or `undefined` (today's `CatalogSkillSchema` rules): two paths that
 * differ only in case land on ONE file on a Mac or on Windows, so what the review listed is not what is written; and a
 * path that is both a file and a folder (`a` and `a/b`) would fail part-way, after the installed skill was removed.
 * The paths are already distinct: `installRefusal` refuses a path given twice before it asks.
 */
function pathCollision(paths: readonly string[]): string | undefined {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const key = path.toLowerCase();
    const earlier = seen.get(key);
    if (earlier !== undefined) return `"${earlier}" and "${path}" would be one file on a Mac or on Windows`;
    seen.set(key, path);
  }
  for (const [key, path] of seen) {
    const segments = key.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const folder = segments.slice(0, depth).join('/');
      if (seen.has(folder)) return `"${seen.get(folder)}" is both a file and a folder (${path})`;
    }
  }
  return undefined;
}

/** Whether `path` is a plain path inside a skill folder (the rules `installRefusal` applies to every file). */
function plainSkillPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  const parts = path.split('/');
  return parts.length <= MAX_PATH_DEPTH && parts.every(part => SEGMENT.test(part) && part !== '.' && part !== '..');
}

/** The reason a skill cannot be installed as given, or `undefined` when it can (nothing is touched to find out). */
export function installRefusal(name: string, files: readonly InstalledSkillFile[]): string | undefined {
  if (!usableSkillName(name)) return `"${name}" is not one plain folder name`;
  if (files.length === 0 || files.length > MAX_INSTALLED_FILES)
    return `a skill holds 1 to ${String(MAX_INSTALLED_FILES)} files`;
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const parts = file.path.split('/');
    if (parts.length > MAX_PATH_DEPTH || !parts.every(part => SEGMENT.test(part) && part !== '.' && part !== '..'))
      return `"${file.path}" is not a plain path inside the skill`;
    if (seen.has(file.path)) return `"${file.path}" is given twice`;
    seen.add(file.path);
    const bytes = new TextEncoder().encode(file.content).byteLength;
    if (bytes > MAX_INSTALLED_FILE_BYTES)
      return `"${file.path}" is larger than ${String(MAX_INSTALLED_FILE_BYTES / 1024)} KiB`;
    total += bytes;
  }
  const collision = pathCollision(files.map(file => file.path));
  if (collision !== undefined) return collision;
  if (total > MAX_INSTALLED_BYTES) return `the skill is larger than ${String(MAX_INSTALLED_BYTES / 1024 / 1024)} MiB`;
  if (!seen.has(SKILL_ENTRY_FILE)) return `the skill has no ${SKILL_ENTRY_FILE}`;
  return undefined;
}

/**
 * The skills Ferretry itself installs (the catalogue's skill items, today `<fleet>/assets/skills/<name>/`): this
 * plugin's own `installed/<name>/` state tree, written and read only through its own state port, and the one source a
 * launch shares from. Nothing else of the machine is shared: a project's skills are neither copied nor linked (owner
 * decision !A466), and a name or path that could leave the folder is refused before anything is written.
 */
export class SkillStore {
  constructor(
    private readonly state: Pick<StatePort, 'write' | 'remove' | 'stat' | 'read' | 'removeEmptyDirectory' | 'entries'>,
    private readonly roots: Pick<RootsPort, 'share'>,
  ) {}

  /**
   * Puts `files` at `installed/<name>/`, replacing the files an earlier install of ours wrote there. Everything is
   * checked before anything is touched, so a refused skill leaves the installed one as it was. Only paths this store
   * remembers writing are ever replaced or removed: anything else on disk in the folder (a file added by hand, a link)
   * refuses the install with {@link InstalledSkillConflict}, and nothing is removed recursively. DECLARED GAP: a folder
   * is not swapped atomically, so a ferret that launches while its skill is being replaced finds the folder partly
   * written.
   */
  async install(name: string, files: readonly InstalledSkillFile[]): Promise<void> {
    const refusal = installRefusal(name, files);
    if (refusal !== undefined) throw new InstalledSkillRefused(refusal);
    const owned = await this.#ownedFiles(name, 'replaced');
    const incoming = new Set(files.map(file => file.path));
    const stale = owned.filter(path => !incoming.has(path));
    if (stale.length > 0) await this.removePaths(name, stale);
    // The index names the new paths before they land, so a crash part-way leaves them ours, not someone else's.
    await this.#remember(name, [...new Set([...owned.filter(path => incoming.has(path)), ...incoming])]);
    for (const file of files) await this.state.write(SKILLS_INSTALLED_STATE, file.content, `${name}/${file.path}`);
  }

  /**
   * Removes what this store wrote into `installed/<name>/` (a name that is not a folder name removes nothing). Anything
   * else in the folder is left, so a folder that held a file added by hand stays, with that file.
   */
  async uninstall(name: string): Promise<void> {
    if (!usableSkillName(name)) return;
    await this.removePaths(name, await this.paths(name));
  }

  /**
   * Every file, link or unreadable folder in `installed/<name>/` as it is on disk now (not as remembered), by path,
   * sorted; empty folders are not listed. Bounded: past {@link MAX_WALKED_ENTRIES} a last entry says there is more.
   */
  async walk(name: string): Promise<readonly InstalledEntry[]> {
    if (!usableSkillName(name)) return [];
    const found: InstalledEntry[] = [];
    const pending: { readonly relative: string; readonly depth: number }[] = [{ relative: '', depth: 0 }];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const at = next.relative === '' ? name : `${name}/${next.relative}`;
      for (const entry of await this.state.entries(SKILLS_INSTALLED_STATE, at)) {
        const path = next.relative === '' ? entry.name : `${next.relative}/${entry.name}`;
        if (found.length >= MAX_WALKED_ENTRIES) {
          found.push({ path: '(more entries than a skill holds)', kind: 'directory' });
          return found.toSorted((left, right) => left.path.localeCompare(right.path));
        }
        if (entry.kind !== 'directory') found.push({ path, kind: entry.kind });
        else if (next.depth + 1 >= MAX_PATH_DEPTH || !SEGMENT.test(entry.name)) found.push({ path, kind: 'directory' });
        else pending.push({ relative: path, depth: next.depth + 1 });
      }
    }
    return found.toSorted((left, right) => left.path.localeCompare(right.path));
  }

  /**
   * The remembered paths that are plain files on disk now, after checking that nothing ELSE is in the folder: a file no
   * install of ours wrote, a link, a folder that cannot be read into. That is what a person added, and it is never
   * replaced or removed (`doing` is the word the refusal uses).
   */
  async #ownedFiles(name: string, doing: string): Promise<readonly string[]> {
    const remembered = new Set(await this.paths(name));
    const owned: string[] = [];
    for (const entry of await this.walk(name))
      if (entry.kind === 'file' && remembered.has(entry.path)) owned.push(entry.path);
      else
        throw new InstalledSkillConflict(
          `${name}/${entry.path} is here but no install of ours wrote it, so the skill was not ${doing}. Move or remove it, then try again.`,
        );
    return owned;
  }

  /** Whether `installed/<name>/` is a plain folder here (a link or a file is not one). */
  async holds(name: string): Promise<boolean> {
    if (!usableSkillName(name)) return false;
    return (await this.state.stat(SKILLS_INSTALLED_STATE, name))?.kind === 'directory';
  }

  /**
   * The paths this store wrote into `installed/<name>/` (what `install` was given), as remembered; empty for a folder
   * it did not write. Only plain skill paths are answered: a tampered list names nothing outside the folder.
   */
  async paths(name: string): Promise<readonly string[]> {
    if (!usableSkillName(name)) return [];
    const read = await this.state.read(SKILLS_INSTALLED_STATE, `${INDEX_FOLDER}/${name}`);
    if (!read.ok || read.value === undefined) return [];
    try {
      const text = typeof read.value === 'string' ? read.value : new TextDecoder().decode(read.value as Uint8Array);
      const listed: unknown = JSON.parse(text);
      return Array.isArray(listed) ? listed.filter((path): path is string => plainSkillPath(path)) : [];
    } catch {
      return [];
    }
  }

  /** One file of an installed skill as bytes, or `undefined` when it is not a plain file there. */
  async read(name: string, path: string): Promise<Uint8Array | undefined> {
    if (!usableSkillName(name) || !plainSkillPath(path)) return undefined;
    const found = await this.state.stat(SKILLS_INSTALLED_STATE, `${name}/${path}`).catch(() => undefined);
    if (found?.kind !== 'file') return undefined;
    const read = await this.state.read(SKILLS_INSTALLED_STATE, `${name}/${path}`).catch(() => undefined);
    if (read === undefined || !read.ok || read.value === undefined) return undefined;
    return typeof read.value === 'string' ? new TextEncoder().encode(read.value) : (read.value as Uint8Array);
  }

  /**
   * Removes exactly `paths` from `installed/<name>/`, then every folder that is left empty (the skill's own folder
   * last), and forgets them. A name or a path that is not a plain skill one removes nothing.
   */
  async removePaths(name: string, paths: readonly string[]): Promise<void> {
    if (!usableSkillName(name)) return;
    const plain = paths.filter(path => plainSkillPath(path));
    // A path is removed only while it is a file or a link: a folder there is never removed with what is in it.
    for (const path of plain) {
      const found = await this.state.stat(SKILLS_INSTALLED_STATE, `${name}/${path}`).catch(() => undefined);
      if (found !== undefined && found.kind !== 'directory')
        await this.state.remove(SKILLS_INSTALLED_STATE, `${name}/${path}`);
    }
    const folders = new Set<string>([name]);
    for (const path of plain) {
      const parts = path.split('/').slice(0, -1);
      for (let depth = 1; depth <= parts.length; depth += 1) folders.add(`${name}/${parts.slice(0, depth).join('/')}`);
    }
    for (const folder of [...folders].toSorted((left, right) => right.length - left.length))
      await this.state.removeEmptyDirectory(SKILLS_INSTALLED_STATE, folder).catch(() => undefined);
    const gone = new Set(plain);
    const left = (await this.paths(name)).filter(path => !gone.has(path));
    if (left.length === 0 && !(await this.holds(name)))
      await this.state.remove(SKILLS_INSTALLED_STATE, `${INDEX_FOLDER}/${name}`);
    else await this.#remember(name, left);
  }

  async #remember(name: string, paths: readonly string[]): Promise<void> {
    await this.state.write(SKILLS_INSTALLED_STATE, JSON.stringify(paths), `${INDEX_FOLDER}/${name}`);
  }

  /**
   * The folder of an installed skill, shared for this launch: `undefined` when the store does not hold it (the item
   * names it before it is installed), when its name could not be a folder here, or when what is there is not a plain
   * folder (a link or a file is never shared).
   */
  async tree(name: string): Promise<SharedTree | undefined> {
    if (!usableSkillName(name)) return undefined;
    const found = await this.state.stat(SKILLS_INSTALLED_STATE, name);
    if (found?.kind !== 'directory') return undefined;
    return await this.roots.share({ state: SKILLS_INSTALLED_STATE, name });
  }
}
