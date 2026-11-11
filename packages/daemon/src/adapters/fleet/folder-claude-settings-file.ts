import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FolderSettingsVariables } from '../../lib/fleet/launch-environment.ts';

/** The two project files Claude Code reads from the folder it starts in. */
const FOLDER_SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'] as const;

/** The local file, which Claude Code keeps at the repository root (the main checkout's, in a worktree). */
const LOCAL_SETTINGS_FILE = '.claude/settings.local.json';

/** How far up from the launch folder a repository is looked for. */
const MAX_DEPTH = 64;

/** A repository's two roots: where the folder's checkout is, and the main checkout it was linked from. */
interface RepositoryRoots {
  readonly root: string;
  readonly main: string;
}

async function readText(path: string): Promise<string | undefined> {
  return await readFile(path, 'utf8').catch(() => undefined);
}

/**
 * The repository a folder lives in, found the way git itself finds it: the nearest ancestor holding a `.git`.
 * A `.git` FILE marks a linked worktree (or a submodule): its `gitdir:` names the per-worktree directory,
 * whose `commondir` names the main repository's `.git`, and the main checkout is that directory's parent.
 * Nothing is run: a folder is not a reason to start `git`.
 */
async function repositoryRoots(cwd: string): Promise<RepositoryRoots | undefined> {
  let directory = resolve(cwd);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const marker = join(directory, '.git');
    const found = await stat(marker).catch(() => undefined);
    if (found?.isDirectory()) return { root: directory, main: directory };
    if (found?.isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec((await readText(marker)) ?? '')?.[1];
      if (pointer === undefined) return { root: directory, main: directory };
      const gitDirectory = resolve(directory, pointer);
      const common = (await readText(join(gitDirectory, 'commondir')))?.trim();
      const commonDirectory = common === undefined || common === '' ? undefined : resolve(gitDirectory, common);
      if (commonDirectory !== undefined)
        return { root: directory, main: basename(commonDirectory) === '.git' ? dirname(commonDirectory) : directory };
      const linked = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/u.exec(gitDirectory)?.[1];
      return { root: directory, main: linked === undefined || linked === '' ? directory : linked };
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
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
 * A file that is absent, unreadable or not a JSON object contributes nothing: Claude ignores a settings file it
 * cannot parse, and a start is not refused over a file that has no effect. File paths and key NAMES are all that
 * leave this adapter; a value is dropped here, so nothing above can hold one.
 */
export class FolderClaudeSettingsFiles implements FolderSettingsVariables {
  constructor(private readonly home: string = homedir()) {}

  async variables(cwd: string): Promise<readonly { readonly file: string; readonly names: readonly string[] }[]> {
    const folder = resolve(cwd);
    const roots = await repositoryRoots(folder);
    const placed = roots?.main;
    const paths = [
      ...FOLDER_SETTINGS_FILES.map(file => join(folder, file)),
      ...(placed === undefined || placed === folder || placed === resolve(this.home)
        ? []
        : [join(placed, LOCAL_SETTINGS_FILE)]),
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
