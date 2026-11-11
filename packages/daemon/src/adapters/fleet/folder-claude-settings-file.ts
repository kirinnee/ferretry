import { readFile, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FolderSettingsUnreadableError, type FolderSettingsVariables } from '../../lib/fleet/launch-environment.ts';

/** The two project files Claude Code reads from the folder it starts in. */
const FOLDER_SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'] as const;

/** The local file, which Claude Code keeps at the repository root (the main checkout's, in a worktree). */
const LOCAL_SETTINGS_FILE = '.claude/settings.local.json';

/** A repository's two roots: where the folder's checkout is, and the main checkout it was linked from. */
interface RepositoryRoots {
  readonly root: string;
  readonly main: string;
}

async function readText(path: string): Promise<string | undefined> {
  return await readFile(path, 'utf8').catch(() => undefined);
}

async function realPathOf(path: string): Promise<string | undefined> {
  return await realpath(path).catch(() => undefined);
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
async function verifiedMainCheckout(worktree: string, marker: string): Promise<string | undefined> {
  const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec((await readText(marker)) ?? '')?.[1];
  if (pointer === undefined) return undefined;
  const gitDirectory = await realPathOf(resolve(worktree, pointer));
  if (gitDirectory === undefined) return undefined;
  const worktrees = dirname(gitDirectory);
  const commonGit = dirname(worktrees);
  if (basename(worktrees) !== 'worktrees' || basename(commonGit) !== '.git') return undefined;
  const common = (await readText(join(gitDirectory, 'commondir')))?.trim();
  const backLink = (await readText(join(gitDirectory, 'gitdir')))?.trim();
  if (common === undefined || common === '' || backLink === undefined || backLink === '') return undefined;
  const [realCommon, realBack, realMarker, realCommonGit] = await Promise.all([
    realPathOf(resolve(gitDirectory, common)),
    realPathOf(resolve(gitDirectory, backLink)),
    realPathOf(marker),
    realPathOf(commonGit),
  ]);
  if (realCommon === undefined || realCommon !== realCommonGit || realBack === undefined || realBack !== realMarker)
    return undefined;
  const commonKind = await lstat(commonGit).catch(() => undefined);
  return commonKind?.isDirectory() === true ? dirname(commonGit) : undefined;
}

/**
 * The repository a folder lives in, found the way git itself finds it: the nearest ancestor holding a `.git`, walking
 * up from the REAL path of the folder (so a symlink alias reaches the same root) all the way to the filesystem root,
 * with no fixed depth. Nothing is run: a folder is not a reason to start `git`.
 *
 * A `.git` directory is the repository. A `.git` FILE marks a linked worktree only when it is proved by
 * {@link verifiedMainCheckout}; unproved, the folder's checkout stands alone. A walk that cannot complete (a
 * directory that cannot be inspected) refuses, rather than leave a settings file unread.
 */
async function repositoryRoots(folder: string): Promise<RepositoryRoots | undefined> {
  let directory = folder;
  for (;;) {
    const marker = join(directory, '.git');
    let found: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      found = await lstat(marker);
    } catch (failure) {
      const code = (failure as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR')
        throw new FolderSettingsUnreadableError(
          `looking for the repository this folder is in failed at ${marker} (${code ?? 'unknown error'}), so its Claude settings cannot be checked`,
        );
    }
    if (found?.isFile()) {
      const main = await verifiedMainCheckout(directory, marker);
      return { root: directory, main: main ?? directory };
    }
    if (found !== undefined) return { root: directory, main: directory };
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
 * The names a Claude launch folder's settings files put in their `env`, from EVERY file Claude Code reads for it.
 *
 * Claude Code reads both project files from the folder it starts in, AND keeps the local file at the repository
 * root — the main checkout's root, in a linked worktree — so a start in `/repo/child` is overridden by
 * `/repo/.claude/settings.local.json` and a worktree by its main checkout's. Outside a repository, or when the
 * root is the home directory, the local file stays with the folder's own
 * (https://code.claude.com/docs/en/settings, "Where Claude Code keeps the local file in a git repository").
 *
 * DISCOVERY NEVER LEAVES THE REPOSITORY: the folder is resolved to its real path, the root is found by an unbounded
 * walk up from it, and a worktree's main checkout is believed only when it proves itself both ways. A file that is
 * absent, unreadable or not a JSON object contributes nothing: Claude ignores a settings file it cannot parse, and a
 * start is not refused over a file that has no effect. File paths and key NAMES are all that leave this adapter; a
 * value is dropped here, so nothing above can hold one.
 */
export class FolderClaudeSettingsFiles implements FolderSettingsVariables {
  constructor(private readonly home: string = homedir()) {}

  async variables(cwd: string): Promise<readonly { readonly file: string; readonly names: readonly string[] }[]> {
    let folder: string;
    try {
      folder = await realpath(resolve(cwd));
    } catch (failure) {
      // A folder that is not there is not one a ferret starts in, so there is nothing of its settings to read.
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new FolderSettingsUnreadableError(
        `the launch folder ${cwd} cannot be resolved (${(failure as NodeJS.ErrnoException).code ?? 'unknown error'}), so its Claude settings cannot be checked`,
      );
    }
    const placed = (await repositoryRoots(folder))?.main;
    const home = (await realPathOf(resolve(this.home))) ?? resolve(this.home);
    const paths = [
      ...FOLDER_SETTINGS_FILES.map(file => join(folder, file)),
      ...(placed === undefined || placed === folder || placed === home ? [] : [join(placed, LOCAL_SETTINGS_FILE)]),
    ];
    const found: { file: string; names: string[] }[] = [];
    for (const path of paths) {
      const text = await readText(path);
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
