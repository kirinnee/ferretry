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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const PREVIEW_MARKER = '.fy-preview';
export const PREVIEW_MARKER_TEXT =
  'ferretry-v5-preview: made by migration/v4-to-v5/preview; safe to remove with preview.sh clean\n';

/** `path` with every existing link resolved; the part that does not exist yet is kept as written. */
export function resolveReal(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      existing = parent;
    }
  }
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
  if (targetInput.split(/[\\/]+/u).includes('..') || v4Input.split(/[\\/]+/u).includes('..'))
    throw new Error('a path with ".." is refused: name the folder in full');
  const v4Home = resolveReal(v4Input);
  const target = resolveReal(targetInput);
  const staging = `${target}.staging`;
  const userHome = resolveReal(home);
  for (const [label, folder] of [
    ['the preview home', target],
    ['its staging copy', resolveReal(staging)],
  ] as const) {
    if (folder === sep || folder === resolve('/')) throw new Error(`${label} must not be the root of the disk`);
    if (folder === userHome) throw new Error(`${label} must not be your home directory`);
    if (inside(folder, userHome)) throw new Error(`${label} must not hold your home directory`);
    if (inside(v4Home, folder)) throw new Error(`${label} must not be v4's home or inside it`);
    if (inside(folder, v4Home)) throw new Error(`${label} must not hold v4's home`);
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
