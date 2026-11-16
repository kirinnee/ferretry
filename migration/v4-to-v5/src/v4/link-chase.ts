/**
 * Follows a path's links with `lstat` and `readlink` ONLY (never `stat`, `open` or `realpath`), COMPONENT BY COMPONENT
 * in filesystem order, to say whether any step lands in the person's terminal sign-in folders (`~/.claude`,
 * `~/.claude.json`, `~/.codex`). Each component is checked against those folders, then `lstat`ed; a link is expanded
 * (its target read relative to the folder holding it) and the walk restarts over the expanded path; a `..` is applied
 * only against the REAL folder walked so far, never to the text, so `pivot/..` after `pivot -> ~/.codex/inner` lands in
 * `~/.codex`, as the filesystem would put it. A service definition may legitimately be a link (home-manager links
 * `fyd.service` into the Nix store), so a link is not refused for being one: only a step into those folders is. The walk
 * stops AT the first step that lands inside, so nothing inside is ever looked at.
 */
import { lstat, readlink } from 'node:fs/promises';
import { join, sep } from 'node:path';

const MAX_HOPS = 16;
export const TERMINAL_FOLDERS: readonly string[] = ['.claude', '.claude.json', '.codex'];

interface Chase {
  /** Where the walk ended: the real path, or the path as far as it could be looked at (the rest stays lexical). */
  readonly end: string;
  /** A real prefix of the walk landed where `stop` said (the walk ended there). */
  readonly hit: boolean;
  /** The chain had more links than the bound: treated as refused by callers. */
  readonly tooDeep: boolean;
}

const parts = (text: string): string[] => text.split(sep).filter(part => part !== '' && part !== '.');

/** `path` walked component by component; `stop` is asked about each real prefix before it is looked at. */
async function chase(path: string, stop: (real: string) => boolean): Promise<Chase> {
  let pending = parts(path.startsWith(sep) ? path : join(process.cwd(), path));
  const real: string[] = [];
  let hops = 0;
  while (pending.length > 0) {
    const [part, ...rest] = pending as [string, ...string[]];
    pending = rest;
    if (part === '..') {
      real.pop();
      continue;
    }
    const next = sep + [...real, part].join(sep);
    if (stop(next)) return { end: next, hit: true, tooDeep: false };
    const facts = await lstat(next).catch(() => undefined);
    // Cannot be looked at (absent, no right to): the rest stays lexical.
    if (facts === undefined) return { end: sep + [...real, part, ...rest].join(sep), hit: false, tooDeep: false };
    if (!facts.isSymbolicLink()) {
      real.push(part);
      continue;
    }
    if (++hops > MAX_HOPS) return { end: next, hit: false, tooDeep: true };
    const target = await readlink(next).catch(() => undefined);
    if (target === undefined) return { end: next, hit: false, tooDeep: true };
    if (target.startsWith(sep)) real.length = 0;
    pending = [...parts(target), ...rest];
  }
  return { end: sep + real.join(sep), hit: false, tooDeep: false };
}

const under = (path: string, base: string): boolean => path === base || path.startsWith(base + sep);

/** The terminal sign-in folders of `homeDirectory`, by both spellings of the home (as given and with its links followed). */
async function terminalFolders(homeDirectory: string): Promise<readonly string[]> {
  const given = parts(homeDirectory.startsWith(sep) ? homeDirectory : join(process.cwd(), homeDirectory));
  const spellings = new Set([sep + given.join(sep), (await chase(homeDirectory, () => false)).end]);
  return [...spellings].flatMap(home => TERMINAL_FOLDERS.map(name => join(home, name)));
}

/**
 * Whether reading `path` would reach the person's terminal sign-in folders: a step of the walk (a link on the way, a
 * `..` after one) lands in `~/.claude`, `~/.claude.json` or `~/.codex` (any spelling of the home). A chain longer than a
 * small bound counts as yes. Nothing is read, and nothing inside those folders is looked at.
 */
export async function pointsIntoTerminalFolder(path: string, homeDirectory: string): Promise<boolean> {
  const folders = await terminalFolders(homeDirectory);
  const result = await chase(path, real => folders.some(base => under(real, base)));
  return result.hit || result.tooDeep;
}
