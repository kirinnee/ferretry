import { MAX_FOLDER_PATH_LENGTH } from '../../../contract/index.ts';

/**
 * Folders under the home that hold keys or sign-ins. They are never listed, never entered and never named in a
 * listing of their parent (a name such as `id_work_ed25519` would leak what is there). Relative to the home, by
 * path segment: `.config/gh` also refuses `.config/gh/anything`.
 */
const PRIVATE_FOLDERS: readonly (readonly string[])[] = [
  ['.ssh'],
  ['.gnupg'],
  ['.claude'],
  ['.codex'],
  ['.config', 'gh'],
  ['.aws'],
  ['.kube'],
  ['.docker'],
  ['.config', 'gcloud'],
  ['.password-store'],
  ['.local', 'share', 'keyrings'],
];

/** A folder that directly holds one of these is a sign-in or key folder wherever it sits, and is not listed. */
const SIGN_IN_FILES: ReadonlySet<string> = new Set([
  '.credentials.json',
  'auth.json',
  'hosts.yml',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_ecdsa_sk',
  'id_ed25519_sk',
]);

const startsWith = (segments: readonly string[], prefix: readonly string[]): boolean =>
  prefix.every((part, index) => segments[index] === part);

/** Whether a path relative to the home (segments) is, or is inside, a private folder. */
export const isPrivateFolder = (relative: readonly string[]): boolean =>
  PRIVATE_FOLDERS.some(folder => startsWith(relative, folder));

/** Whether a folder's own names show it holds a sign-in or a key. */
export const holdsSignIn = (names: readonly string[]): boolean => names.some(name => SIGN_IN_FILES.has(name));

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
