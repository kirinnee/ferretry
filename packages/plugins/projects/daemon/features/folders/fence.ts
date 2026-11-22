import { PRIVATE_FOLDERS } from '@ferretry/std';
import { MAX_FOLDER_PATH_LENGTH } from '../../../contract/index.ts';

/**
 * What a name means — the fold, the private folders, the sign-in files — is `secret-names.ts` in `@ferretry/std`, the one list
 * this fence and the ferret file reader (`core/ferrets` `path-policy.ts`) both read. Re-exported so the explorer reads
 * its fence from one place; a name is never decided here.
 */
export { foldName, holdsSignIn, isPrivateFolder } from '@ferretry/std';

/** Every private folder as an absolute spelling under `home`: the paths whose REAL location is then looked up per request. */
export const privateSpellings = (home: string): readonly string[] => {
  const base = home.replace(/\/+$/, '');
  return PRIVATE_FOLDERS.map(folder => `${base}/${folder.join('/')}`);
};

/** Whether the real path `real` is `root` or inside it. */
export const isAtOrUnder = (real: string, root: string): boolean =>
  real === root || real.startsWith(root.endsWith('/') ? root : `${root}/`);

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
