/**
 * Follows a path's links with `readlink` ONLY (never `stat`, `open` or `realpath`), resolving each target lexically, to
 * say whether any hop lands in the person's terminal sign-in folders (`~/.claude`, `~/.claude.json`, `~/.codex`). A
 * service definition may legitimately be a link (home-manager links `fyd.service` into the Nix store), so a link is
 * not refused for being one: only a hop into those folders is. An entry is `lstat`ed before anything below it, and the
 * walk stops AT the first hop that lands inside, so nothing inside is ever looked at.
 */
import { lstat, readlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const MAX_HOPS = 16;
export const TERMINAL_FOLDERS: readonly string[] = ['.claude', '.claude.json', '.codex'];

interface Chase {
  /** Every lexical path the walk produced, the starting one first (the last is where the chain ends). */
  readonly paths: readonly string[];
  /** The chain had more links than the bound: treated as refused by callers. */
  readonly tooDeep: boolean;
}

/** `path` followed through its links; `stop` ends the walk early (a hop that is already refused). */
async function chase(path: string, stop: (path: string) => boolean): Promise<Chase> {
  let current = resolve(path);
  const paths = [current];
  let hops = 0;
  if (stop(current)) return { paths, tooDeep: false };
  for (;;) {
    const parts = current.split(sep).filter(part => part !== '');
    let walked: string = sep;
    let moved = false;
    for (const [index, part] of parts.entries()) {
      const next = join(walked, part);
      const facts = await lstat(next).catch(() => undefined);
      if (facts === undefined) return { paths, tooDeep: false };
      if (facts.isSymbolicLink()) {
        if (++hops > MAX_HOPS) return { paths, tooDeep: true };
        const target = await readlink(next).catch(() => undefined);
        if (target === undefined) return { paths, tooDeep: true };
        current = resolve(walked, target, ...parts.slice(index + 1));
        paths.push(current);
        if (stop(current)) return { paths, tooDeep: false };
        moved = true;
        break;
      }
      walked = next;
    }
    if (!moved) return { paths, tooDeep: false };
  }
}

const under = (path: string, base: string): boolean => path === base || path.startsWith(base + sep);

/** The terminal sign-in folders of `homeDirectory`, by every spelling of the home (as given and with its links followed). */
async function terminalFolders(homeDirectory: string): Promise<readonly string[]> {
  const spellings = (await chase(homeDirectory, () => false)).paths;
  return [...new Set(spellings.flatMap(home => TERMINAL_FOLDERS.map(name => join(home, name))))];
}

/**
 * Whether reading `path` would reach the person's terminal sign-in folders: it, or a link on the way, lands in
 * `~/.claude`, `~/.claude.json` or `~/.codex` (any spelling of the home). A chain longer than a small bound counts as
 * yes. Nothing is read, and nothing inside those folders is looked at.
 */
export async function pointsIntoTerminalFolder(path: string, homeDirectory: string): Promise<boolean> {
  const folders = await terminalFolders(homeDirectory);
  const inside = (candidate: string): boolean => folders.some(base => under(candidate, base));
  const result = await chase(path, inside);
  return result.tooDeep || result.paths.some(inside);
}
