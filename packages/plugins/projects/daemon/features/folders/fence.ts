import { foldName, isPrivateFolder, PRIVATE_FOLDERS } from '@ferretry/std';
import { MAX_FOLDER_PATH_LENGTH } from '../../../contract/index.ts';

/**
 * What a name means — the fold, the private folders, the sign-in files — is `secret-names.ts` in `@ferretry/std`, the one list
 * this fence and the ferret file reader (`core/ferrets` `path-policy.ts`) both read. Re-exported so the explorer reads
 * its fence from one place; a name is never decided here.
 */
export { foldName, holdsSignIn, isPrivateFolder } from '@ferretry/std';

/**
 * What a PROJECT reader keeps out under the home beyond that list: the macOS `~/Library` (Mail, Messages, Keychains, browser
 * profiles). Applied by name on every platform: a Linux home that has a `~/Library` loses one folder, a Mac that slipped
 * loses its mail. The ferret file reader has its own say about it.
 */
const LIBRARY = 'Library';

/** Whether a path relative to a home (segments) is, or is inside, a private folder or the macOS `~/Library`. */
export const isPrivateBelowHome = (relative: readonly string[]): boolean =>
  isPrivateFolder(relative) || (relative[0] !== undefined && foldName(relative[0]) === foldName(LIBRARY));

/** Every private folder as an absolute spelling under `home`: the paths whose REAL location is then looked up per request. */
export const privateSpellings = (home: string): readonly string[] => {
  const base = home.replace(/\/+$/, '');
  return [...PRIVATE_FOLDERS.map(folder => folder.join('/')), LIBRARY].map(folder => `${base}/${folder}`);
};

/**
 * Trees a project is never read from on any machine: runtime and pseudo filesystems (other processes' memory, endless
 * names) and the huge read-only trees no one keeps a project in. Judged on the real path.
 */
const SKIPPED_TREES: readonly string[] = [
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/var/run',
  '/nix/store',
  '/System',
  '/private/var',
];

/** Folders that are somebody's home, whole. */
const HOME_FOLDERS: readonly string[] = ['/root', '/var/root'];
/** Folders whose every child is somebody's home. */
const HOME_PARENTS: readonly string[] = ['/home', '/Users'];

/** Whether the real path `real` is `root` or inside it. */
export const isAtOrUnder = (real: string, root: string): boolean =>
  real === root || real.startsWith(root.endsWith('/') ? root : `${root}/`);

/** Whether the real path is in a tree a project is never read from (never the owner's own home, wherever it sits). */
export const isSkippedTree = (real: string, home: string): boolean =>
  !isAtOrUnder(real, home) && SKIPPED_TREES.some(tree => isAtOrUnder(real, tree));

/**
 * Whether the real path is in ANOTHER user's home: `/home/<x>`, `/Users/<x>`, `/root`, `/var/root`, below the owner's own
 * (which may be any of them). `/home` and `/Users` themselves are not: they are only the folder the homes are in.
 */
export const isOtherHome = (real: string, home: string): boolean => {
  if (isAtOrUnder(real, home)) return false;
  if (HOME_FOLDERS.some(folder => isAtOrUnder(real, folder))) return true;
  return HOME_PARENTS.some(parent => real.startsWith(`${parent}/`));
};

/** Whether the real path is a place so wide that a project there is "your whole disk or home": `/`, a home's parent, the home. */
export const isBroadRoot = (real: string, home: string): boolean =>
  real === '/' || real === home || HOME_PARENTS.includes(real);

export type PathParse =
  | { readonly ok: true; readonly absolute: string }
  | { readonly ok: false; readonly message: string };

/**
 * The absolute path a request names: `~`, `~/x` or `/abs/x`. Refused: anything else (a relative path would resolve
 * against the daemon's own folder), a NUL, a `..` or `.` segment (no lexical walking out of a folder), and `~user`.
 * A trailing slash and doubled slashes are tolerated.
 */
export function parsePath(raw: string, home: string): PathParse {
  if (raw === '' || raw.length > MAX_FOLDER_PATH_LENGTH || raw.includes('\0'))
    return { ok: false, message: 'the folder path is empty, too long or not text' };
  let rest: string;
  let base: string;
  if (raw === '~' || raw.startsWith('~/')) {
    base = home;
    rest = raw.slice(1);
  } else if (raw.startsWith('/')) {
    base = '';
    rest = raw;
  } else return { ok: false, message: 'a folder path is absolute, or starts with ~/ for the home folder' };
  const segments = rest.split('/').filter(segment => segment !== '');
  if (segments.some(segment => segment === '.' || segment === '..'))
    return { ok: false, message: 'a folder path has no . or .. in it' };
  const joined = `${base}/${segments.join('/')}`.replace(/\/+$/, '');
  return { ok: true, absolute: joined === '' ? '/' : joined };
}

/** The segments of `real` below `home`, or undefined when `real` is not the home or inside it. */
export function belowHome(real: string, home: string): readonly string[] | undefined {
  if (real === home) return [];
  const prefix = home.endsWith('/') ? home : `${home}/`;
  if (!real.startsWith(prefix)) return undefined;
  return real
    .slice(prefix.length)
    .split('/')
    .filter(segment => segment !== '');
}
