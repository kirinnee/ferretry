/**
 * Where the preview may write and remove. Every entry point (`preview.sh`, `main.ts`) asks this module first, so
 * one fact has one owner: the preview home is NEVER v4's home, never inside it, never a folder that holds it, and
 * never the user's home or `/`. Paths are compared after resolving every existing link, so a trailing slash, a `..`
 * or a symlink to v4's home cannot slip past a string compare.
 *
 * The preview home is also marked: `prepare` writes {@link PREVIEW_MARKER} when it finishes, and `clean` removes
 * nothing that does not carry it.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveReal } from '../src/v4/homes.ts';

export const PREVIEW_MARKER = '.fy-preview';
export const PREVIEW_MARKER_TEXT =
  'ferretry-v5-preview: made by migration/v4-to-v5/preview; safe to remove with preview.sh clean\n';

/**
 * Like {@link resolveReal}, but a link that does not resolve (dangling, or a loop) is REFUSED, component by component:
 * a write through such a link would land wherever the link later points, and `realpath` cannot say where that is now.
 */
export function resolveStrict(path: string): string {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (let index = 0; index < parts.length; index++) {
    const next = join(current, parts[index] as string);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return join(current, ...parts.slice(index));
      throw new Error(`${next} cannot be inspected (${code ?? 'error'}); refused`);
    }
    if (info.isSymbolicLink()) {
      try {
        current = realpathSync(next);
      } catch {
        throw new Error(`${next} is a link that does not resolve (dangling or a loop); refused`);
      }
    } else current = next;
  }
  return current;
}

const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export interface Guarded {
  readonly v4Home: string;
  /** The resolved preview home: the only spelling any later step uses. */
  readonly target: string;
  readonly staging: string;
}

/** Throws a sentence when `target` could reach v4's home, the user's home or `/`. Returns the resolved paths. */
export function guardTarget(v4Input: string, targetInput: string, home: string = homedir()): Guarded {
  if (targetInput.trim() === '') throw new Error('the preview home must be named');
  if (!isAbsolute(targetInput))
    throw new Error(
      `the preview home must be an absolute path (a "~" or a relative name is not expanded here): ${targetInput}`,
    );
  if (!isAbsolute(v4Input)) throw new Error(`v4's home must be an absolute path: ${v4Input}`);
  if (targetInput.split(/[\\/]+/u).includes('..') || v4Input.split(/[\\/]+/u).includes('..'))
    throw new Error('a path with ".." is refused: name the folder in full');
  const v4Home = resolveStrict(v4Input);
  const target = resolveStrict(targetInput);
  const staging = `${target}.staging`;
  const stagingResolved = resolveStrict(staging);
  const userHome = resolveReal(home);
  // v4's home as the caller named it, AND the places v4 lives by default (the real user's, and the `home` given), each
  // with its managed-worktree sibling: whatever `--v4` says, none of them may be written to or removed.
  const protectedHomes = new Set<string>();
  for (const base of [v4Home, resolveReal(join(homedir(), '.ferretry')), resolveReal(join(home, '.ferretry'))]) {
    protectedHomes.add(base);
    protectedHomes.add(`${base}-worktrees`);
  }
  for (const [label, folder] of [
    ['the preview home', target],
    ['its staging copy', stagingResolved],
  ] as const) {
    if (folder === sep || folder === resolve('/')) throw new Error(`${label} must not be the root of the disk`);
    if (folder === userHome) throw new Error(`${label} must not be your home directory`);
    if (inside(folder, userHome)) throw new Error(`${label} must not hold your home directory`);
    for (const guarded of protectedHomes) {
      if (inside(guarded, folder))
        throw new Error(`${label} must not be v4's home (or its worktree folder) or inside it`);
      if (inside(folder, guarded)) throw new Error(`${label} must not hold v4's home (or its worktree folder)`);
    }
  }
  return { v4Home, target, staging };
}

/** Whether `target` carries the marker `prepare` writes: a regular file, not a link, with the marker's own text. */
export function hasMarker(target: string): boolean {
  const path = join(target, PREVIEW_MARKER);
  try {
    if (!lstatSync(path).isFile()) return false;
    return readFileSync(path, 'utf8') === PREVIEW_MARKER_TEXT;
  } catch {
    return false;
  }
}
