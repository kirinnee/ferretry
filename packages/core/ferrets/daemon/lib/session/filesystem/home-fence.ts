import { isAbsolute, normalize, relative, sep } from 'node:path';

/**
 * The state-home fence the file browser consults, cut from today's `packages/fleet/src/lib/state-home-guard.ts`
 * (`StateHomes`, `stateHomeByName`). The host resolves the homes; Ferrets only reads the resolved value (core cannot
 * import the fleet package).
 */

export interface KnownDirectory {
  readonly named: string;
  readonly real: string;
  readonly device: bigint;
  readonly inode: bigint;
}

declare const stateHomesBrand: unique symbol;

/** The resolved homes and the openings inside them; made only by the host (today: `resolveStateHomes`). */
export interface StateHomes {
  readonly homes: readonly KnownDirectory[];
  /** Folders inside a home that ARE reachable (e.g. the fleet's assets), by name and identity. */
  readonly openings: readonly KnownDirectory[];
  /**
   * The home's key files and folders by identity, so a bind mount of one of them alone is still seen — and by
   * `place`, the real path of where each one is, which is the one place a folder walk may meet it.
   */
  readonly pinned: readonly { readonly device: bigint; readonly inode: bigint; readonly place: string }[];
  readonly [stateHomesBrand]: true;
}

/** Whether a path is inside a home — `home` names it when so. */
export type HomeVerdict = { readonly inside: false } | { readonly inside: true; readonly home: string };

const OUTSIDE: HomeVerdict = { inside: false };

function absolute(path: string, what: string): string {
  if (!isAbsolute(path)) throw new TypeError(`${what} must be an absolute path: ${path}`);
  return normalize(path);
}

const within = (directory: string, path: string): boolean => {
  const from = relative(directory, path);
  // '..' as a whole first segment only: a child named '..cache' is inside, and must not read as outside.
  return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from));
};


export function stateHomeByName(homes: StateHomes, path: string): HomeVerdict {
  const target = absolute(path, 'the path');
  const names = (directory: KnownDirectory): readonly string[] => [directory.named, directory.real];
  if (homes.openings.some(opening => names(opening).some(name => within(name, target)))) return OUTSIDE;
  const home = homes.homes.find(directory => names(directory).some(name => within(name, target)));
  return home === undefined ? OUTSIDE : { inside: true, home: home.named };
}
