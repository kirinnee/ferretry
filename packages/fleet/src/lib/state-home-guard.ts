import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * THE STATE-HOME GUARD: whether a path an agent named reaches the daemon's own state home (`FY_HOME`: the API
 * tokens, the tmux socket, the vault and its key, `state/`, `config/`, every agent's credential home).
 *
 * Generic on purpose — any surface that reads a file for an agent and hands it on asks the same three
 * questions: which homes are there (as configured AND as resolved, so a symlinked home is recognised), is
 * this path inside one (asked of the path as named and again of its real path, so no symlink hop gets
 * past), and is the file that was opened still the one that was checked (same real path, same device and
 * inode, one name — a hard link's other name could be anywhere). Every answer fails closed. The disk is a
 * port, so this module never touches it itself. In fleet so the daemon and the fleet share ONE guard; the daemon's file
 * tools are its first user (docs/agent-tools.md#files).
 */

/** Which file an entry is: what kind, and the device and inode that name it whatever path reached it. */
export interface FileIdentity {
  readonly kind: 'file' | 'directory' | 'link' | 'other';
  readonly device: bigint;
  readonly inode: bigint;
  /** How many names (hard links) the file has. */
  readonly links: number;
  readonly size: number;
}

/** The slice of a disk the guard reads. */
export interface StateHomeDisk {
  realpath(path: string): Promise<string>;
  /** The entry itself, never followed; `undefined` when nothing is there. */
  identity(path: string): Promise<FileIdentity | undefined>;
}

/** A state home that could not be resolved: nothing may be reached until it can. */
export class StateHomeUnresolvedError extends Error {
  constructor() {
    super('the daemon’s state home cannot be resolved');
    this.name = 'StateHomeUnresolvedError';
  }
}

/**
 * Every configured home and its real path, without repeats. Throws {@link StateHomeUnresolvedError} when one
 * cannot be resolved, because a symlinked home that is not resolved cannot be recognised by its real path.
 */
export async function resolveStateHomes(
  configured: readonly string[],
  disk: Pick<StateHomeDisk, 'realpath'>,
): Promise<readonly string[]> {
  const named = configured.map(home => resolve(home));
  let real: readonly string[];
  try {
    real = await Promise.all(named.map(async home => await disk.realpath(home)));
  } catch {
    throw new StateHomeUnresolvedError();
  }
  return [...new Set([...named, ...real])];
}

/** The home that holds `path` (compared as paths, not strings), or `undefined` when none does. */
export function stateHomeHolding(homes: readonly string[], path: string): string | undefined {
  return homes.find(home => {
    const from = relative(home, path);
    // '..' as a whole first segment only: a child named '..cache' is inside, and must not read as outside.
    return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from));
  });
}

/** Why an opened file may not be handed on, or `undefined` when it may. */
export type OpenedFileProblem = 'not-a-file' | 'hard-link' | 'changed';

/**
 * Whether the file opened at `real` (a path `realpath` returned) may be handed on: a regular file with one
 * name, still at `real` — the same canonical path, the same device and inode. Asked AFTER the open, so a link
 * or another file swapped in between the check and the open shows here rather than being read. `changed` is
 * decided before `hard-link`, so a caller that must tolerate hard links (a declared limit) still learns of a swap.
 */
export async function openedFileProblem(
  real: string,
  opened: FileIdentity,
  disk: StateHomeDisk,
): Promise<OpenedFileProblem | undefined> {
  if (opened.kind !== 'file') return 'not-a-file';
  const again = await disk.realpath(real).catch(() => undefined);
  const there = again === real ? await disk.identity(real) : undefined;
  if (there?.kind !== 'file' || there.device !== opened.device || there.inode !== opened.inode) return 'changed';
  if (opened.links > 1) return 'hard-link';
  return undefined;
}
