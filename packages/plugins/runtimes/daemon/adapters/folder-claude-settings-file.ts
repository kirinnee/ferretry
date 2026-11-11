import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RootHandle, RootLstat } from '@ferretry/kernel/contract';
import { FolderSettingsUnreadableError, type FolderSettingsVariables } from '../lib/folder-settings.ts';

/** The two project files Claude Code reads from the folder it starts in. */
const FOLDER_SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'] as const;

/** The local file, which Claude Code keeps at the repository root (the main checkout's, in a worktree). */
const LOCAL_SETTINGS_FILE = '.claude/settings.local.json';

/**
 * The kernel's `harness-home` root over ONE absolute folder the caller names: read-only, never follows a link out of
 * the folder, refuses the daemon's own home. The composition passes
 * `folder => kernel.roots.root('harness-home', { subfolder: folder })`; a test passes the kernel's `diskFolders`.
 */
export type FolderRoots = (folder: string) => RootHandle;

/** A repository's two roots: where the folder's checkout is, and the main checkout it was linked from. */
interface RepositoryRoots {
  readonly root: string;
  readonly main: string;
}

/** Why a disk step failed, in a few words: the kernel's refusal, or the system error's code. */
function why(failure: unknown): string {
  const found = failure as { readonly refusal?: unknown; readonly code?: unknown } | null | undefined;
  const reason = found?.refusal ?? found?.code;
  return typeof reason === 'string' ? reason : 'unknown error';
}

/** Everything this adapter asks of the disk, each through the kernel's root over the folder the name is in. */
class Disk {
  constructor(private readonly roots: FolderRoots) {}

  /** The handle on the folder `path` is in, and the name it has there (`path` is absolute, so the name is plain). */
  #in(path: string): { readonly handle: RootHandle; readonly name: ReturnType<RootHandle['resolve']> } {
    const handle = this.roots(dirname(path));
    return { handle, name: handle.resolve(basename(path)) };
  }

  /** What is AT `path`, never followed; `undefined` when nothing is. Throws when the answer cannot be had. */
  async look(path: string): Promise<RootLstat | undefined> {
    const { handle, name } = this.#in(path);
    if (!name.ok) throw Object.assign(new Error(`root refused: ${name.error}`), { refusal: name.error });
    return await handle.lstat(name.value);
  }

  /** The text of a file, or `undefined` when it cannot be read (absent, a link, a second name, no permission). */
  async text(path: string): Promise<string | undefined> {
    const { handle, name } = this.#in(path);
    if (!name.ok) return undefined;
    return await handle.readText(name.value).catch(() => undefined);
  }

  /** The real path of an existing name, links resolved (it must lie inside the folder it is in), or `undefined`. */
  async real(path: string): Promise<string | undefined> {
    if (dirname(path) === path) return path;
    const { handle, name } = this.#in(path);
    if (!name.ok) return undefined;
    return await handle.realPath(name.value).catch(() => undefined);
  }

  /** The real path of a FOLDER, or `undefined` when it is not there or cannot be reached. */
  async realFolder(folder: string): Promise<string | undefined> {
    const handle = this.roots(folder);
    const name = handle.resolve('.');
    if (!name.ok) return undefined;
    return await handle.realPath(name.value).catch(() => undefined);
  }
}

/**
 * The main checkout a linked worktree's `.git` file belongs to, only when the two PROVE it of each other.
 *
 * A `.git` file is text a repository's contents can write, and `gitdir:` and `commondir` can name any path, so
 * neither is believed on its own. The worktree is accepted only when: the real `gitdir` is
 * `<main>/.git/worktrees/<name>`; that directory's own `gitdir` file points back, after `realpath`, to this
 * worktree's `.git` file; and its `commondir` resolves to `<main>/.git`. Anything else is `undefined` and the caller
 * treats the folder as an ordinary checkout, so a path that could not be verified is never read.
 */
async function verifiedMainCheckout(disk: Disk, worktree: string, marker: string): Promise<string | undefined> {
  const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec((await disk.text(marker)) ?? '')?.[1];
  if (pointer === undefined) return undefined;
  const gitDirectory = await disk.real(resolve(worktree, pointer));
  if (gitDirectory === undefined) return undefined;
  const worktrees = dirname(gitDirectory);
  const commonGit = dirname(worktrees);
  if (basename(worktrees) !== 'worktrees' || basename(commonGit) !== '.git') return undefined;
  const common = (await disk.text(join(gitDirectory, 'commondir')))?.trim();
  const backLink = (await disk.text(join(gitDirectory, 'gitdir')))?.trim();
  if (common === undefined || common === '' || backLink === undefined || backLink === '') return undefined;
  const [realCommon, realBack, realMarker, realCommonGit] = await Promise.all([
    disk.real(resolve(gitDirectory, common)),
    disk.real(resolve(gitDirectory, backLink)),
    disk.real(marker),
    disk.real(commonGit),
  ]);
  if (realCommon === undefined || realCommon !== realCommonGit || realBack === undefined || realBack !== realMarker)
    return undefined;
  const commonKind = await disk.look(commonGit).catch(() => undefined);
  return commonKind?.kind === 'directory' ? dirname(commonGit) : undefined;
}

/**
 * The repository a folder lives in, found the way git itself finds it: the nearest ancestor holding a `.git`, walking
 * up from the REAL path of the folder (so a symlink alias reaches the same root) all the way to the filesystem root,
 * with no fixed depth. Nothing is run: a folder is not a reason to start `git`.
 *
 * A `.git` directory is the repository. A `.git` FILE marks a linked worktree only when it is proved by
 * {@link verifiedMainCheckout}. WHEN THE LAYOUT CANNOT BE PROVED THE LAUNCH IS REFUSED, never guessed as "a checkout
 * that stands alone": a `.git` that is a symlink or anything but a directory or file, a `.git` file that fails
 * its proof, and a walk that cannot complete (a directory that cannot be inspected) all refuse, because git (or
 * Claude) may still find a main checkout whose settings file would then be left unread.
 */
async function repositoryRoots(disk: Disk, folder: string): Promise<RepositoryRoots | undefined> {
  let directory = folder;
  for (;;) {
    const marker = join(directory, '.git');
    let found: RootLstat | undefined;
    try {
      found = await disk.look(marker);
    } catch (failure) {
      throw new FolderSettingsUnreadableError(
        `looking for the repository this folder is in failed at ${marker} (${why(failure)}), so its Claude settings cannot be checked`,
      );
    }
    if (found?.kind === 'directory') return { root: directory, main: directory };
    if (found?.kind === 'file') {
      const main = await verifiedMainCheckout(disk, directory, marker);
      if (main === undefined)
        throw new FolderSettingsUnreadableError(
          `the folder ${directory} has a .git file that does not prove it is a linked worktree of the repository it names (the worktree's gitdir, its back-link and commondir disagree; a submodule's does too), so its Claude settings cannot be checked. Start the ferret in the main repository folder or in a worktree made by \`git worktree add\`, instead`,
        );
      return { root: directory, main };
    }
    if (found !== undefined)
      throw new FolderSettingsUnreadableError(
        `the folder ${directory} has a .git that is neither a plain directory nor a plain file (a symlink, for one), so which repository it belongs to cannot be proved and its Claude settings cannot be checked. Start the ferret in the repository's real folder instead`,
      );
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** A path as the refusal names it: relative to the launch folder when inside it, absolute otherwise. */
function shown(cwd: string, path: string): string {
  const inside = relative(cwd, path);
  return inside === '' || inside.startsWith('..') || isAbsolute(inside) ? path : inside.split(sep).join('/');
}

/**
 * The text of one settings file, or `undefined` when there is none to read. A file Claude Code would read but this
 * adapter may not (a link, a second hard link, or a link on the way to it) REFUSES the launch: reading nothing from it
 * would leave the one file that blanks the login unseen.
 */
async function settingsText(disk: Disk, path: string): Promise<string | undefined> {
  let found: RootLstat | undefined;
  try {
    found = await disk.look(path);
  } catch (failure) {
    // A folder that is not there (no `.claude`) is no file; anything else cannot be told from a hidden one.
    if ((await disk.look(dirname(path)).catch(() => 'unknown' as const)) === undefined) return undefined;
    throw new FolderSettingsUnreadableError(
      `the settings file ${path} cannot be looked at (${why(failure)}), so its Claude settings cannot be checked. Start the ferret in a folder whose .claude is a plain folder`,
    );
  }
  if (found === undefined || found.kind === 'directory' || found.kind === 'other') return undefined;
  if (found.kind === 'symlink' || found.links > 1)
    throw new FolderSettingsUnreadableError(
      `the settings file ${path} is a link or has a second name, which Claude Code follows and this daemon does not, so its Claude settings cannot be checked. Replace it with a plain file`,
    );
  return await disk.text(path);
}

/**
 * The names a Claude launch folder's settings files put in their `env`, from EVERY file Claude Code reads for it.
 *
 * Claude Code reads both project files from the folder it starts in, AND keeps the local file at the repository
 * root — the main checkout's root, in a linked worktree — so a start in `/repo/child` is overridden by
 * `/repo/.claude/settings.local.json` and a worktree by its main checkout's. Outside a repository, or when the
 * root is the home directory, the local file stays with the folder's own
 * (https://code.claude.com/docs/en/settings, "Where Claude Code keeps the local file in a git repository").
 *
 * EVERY READ GOES THROUGH THE KERNEL (`harness-home`, one root per folder asked about, read-only, no link followed
 * out of the folder). DISCOVERY NEVER LEAVES THE REPOSITORY: the folder is resolved to its real path, the root is found by an unbounded
 * walk up from it, and a worktree's main checkout is believed only when it proves itself both ways; a folder or a
 * layout that cannot be resolved or proved refuses the launch. A file that is
 * absent, unreadable or not a JSON object contributes nothing: Claude ignores a settings file it cannot parse, and a
 * start is not refused over a file that has no effect. File paths and key NAMES are all that leave this adapter; a
 * value is dropped here, so nothing above can hold one.
 */
export class FolderClaudeSettingsFiles implements FolderSettingsVariables {
  readonly #disk: Disk;

  /** `home` is the person's home directory: the walk's limit for the repository's local file. */
  constructor(
    roots: FolderRoots,
    private readonly home: string,
  ) {
    this.#disk = new Disk(roots);
  }

  async variables(cwd: string): Promise<readonly { readonly file: string; readonly names: readonly string[] }[]> {
    const disk = this.#disk;
    // A folder that is not there now can be made before the pane starts, inside a repository whose settings then
    // apply, so it is refused like any folder that cannot be resolved.
    const folder = await disk.realFolder(resolve(cwd));
    if (folder === undefined)
      throw new FolderSettingsUnreadableError(
        `the launch folder ${cwd} cannot be resolved, so its Claude settings cannot be checked. Start the ferret in a folder that exists and can be read`,
      );
    const placed = (await repositoryRoots(disk, folder))?.main;
    const home = (await disk.realFolder(resolve(this.home))) ?? resolve(this.home);
    const paths = [
      ...FOLDER_SETTINGS_FILES.map(file => join(folder, file)),
      ...(placed === undefined || placed === folder || placed === home ? [] : [join(placed, LOCAL_SETTINGS_FILE)]),
    ];
    const found: { file: string; names: string[] }[] = [];
    for (const path of paths) {
      const text = await settingsText(disk, path);
      if (text === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      const env = (parsed as { env?: unknown } | null)?.env;
      if (typeof env !== 'object' || env === null || Array.isArray(env)) continue;
      found.push({ file: shown(folder, path), names: Object.keys(env) });
    }
    return found;
  }
}
