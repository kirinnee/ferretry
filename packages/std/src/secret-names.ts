/**
 * The ONE list of names that say "this holds a key or a sign-in" — for files, for the folders that hold them, and for
 * the private folders under a home. Two programs used to keep their own copy and disagreed (`hosts.yml` and `auth.json`
 * were refused only where a folder was listed, `.env` and `*.pem` only where a file was read), so a name one of them hid
 * the other showed. Both now read THIS module: the ferret file reader and index (`core/ferrets` `path-policy.ts`) and
 * the project folder explorer and repo scan (`plugins/projects` `fence.ts`).
 *
 * Pure and total: names in, a verdict out, no IO. Every name is judged after {@link foldName}, so `ID_RSA`, a
 * full-width spelling and an invisible-character spelling are the same name. The list over-matches on purpose — a
 * secret that slips through costs everything, a refused harmless name costs one click.
 *
 * Three questions, kept apart because they have different costs when wrong:
 *
 * - {@link isSecretFileName} — may this FILE be read or listed? (`.env`, `*.pem`, `id_*`, `auth.json`, …)
 * - {@link holdsSignIn} — does a folder's own listing show it IS a sign-in or key folder? Only the sign-in files (a
 *   project folder with a `.env` or an `.npmrc` is an ordinary project, so those never make a folder private).
 * - {@link isPrivateFolder} / {@link isSecretFolderName} — is this FOLDER one that holds keys (`.ssh`, `.config/gh`)?
 */

/**
 * One name as a filesystem would compare it: Unicode-compatibility-normalized (macOS stores names decomposed, and `ﬁ`
 * or a full-width letter can read as the plain one), marks and invisible code points dropped (an HFS+ volume ignores
 * them), then lower-cased. It over-matches on purpose: on a case-sensitive Linux disk `.SSH` is a different folder, but
 * refusing it costs nothing and a private folder that slips through on a case-insensitive disk costs everything.
 */
export const foldName = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, '')
    .toLowerCase();

/**
 * Sign-in files: a folder that directly holds one of these is a sign-in or key folder wherever it sits, and a file with
 * one of these names is never served. Exact names, compared as {@link foldName} folds them.
 */
export const SIGN_IN_FILES: readonly string[] = [
  '.credentials.json',
  'auth.json',
  'hosts.yml',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_ecdsa_sk',
  'id_ed25519_sk',
];

/** Secret-looking file names beyond the sign-in files: matched on the folded name, so `.ENV` and `Server.PEM` match. */
const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env$/,
  /^\.env\..*$/,
  /^secrets?\.ya?ml$/,
  /^secrets?\.enc\.ya?ml$/,
  /^secrets?\.json$/,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /^id_ed25519/,
  /^id_ecdsa/,
  /^id_dsa/,
  /\.age$/,
  /credentials.*\.json$/,
  /\.kdbx$/,
  /^\.netrc$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.pgpass$/,
  /^\.htpasswd$/,
  /\.p12$/,
  /\.pfx$/,
  /\.jks$/,
  /\.keystore$/,
];

const FOLDED_SIGN_IN: ReadonlySet<string> = new Set(SIGN_IN_FILES.map(foldName));

/** Whether one file name says it holds a key, a secret or a sign-in. */
export const isSecretFileName = (name: string): boolean => {
  const folded = foldName(name);
  return FOLDED_SIGN_IN.has(folded) || SECRET_FILE_PATTERNS.some(pattern => pattern.test(folded));
};

/** Whether a folder's own names show it holds a sign-in or a key. */
export const holdsSignIn = (names: readonly string[]): boolean =>
  names.some(name => FOLDED_SIGN_IN.has(foldName(name)));

/**
 * Folders under a home that hold keys or sign-ins. They are never listed, never entered and never named in a listing of
 * their parent (a name such as `id_work_ed25519` would leak what is there). Relative to the home, by path segment,
 * compared as {@link foldName} folds them: `.config/gh` also refuses `.config/gh/anything` and `.Config/GH`.
 */
export const PRIVATE_FOLDERS: readonly (readonly string[])[] = [
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

const FOLDED_PRIVATE: readonly (readonly string[])[] = PRIVATE_FOLDERS.map(folder => folder.map(foldName));

const startsWith = (segments: readonly string[], prefix: readonly string[]): boolean =>
  prefix.every((part, index) => segments[index] !== undefined && foldName(segments[index] as string) === part);

/** Whether a path relative to a home (segments) is, or is inside, a private folder. */
export const isPrivateFolder = (relative: readonly string[]): boolean =>
  FOLDED_PRIVATE.some(folder => startsWith(relative, folder));

/**
 * Folders that hold nothing but keys, so they are refused at ANY depth by name, with no home to anchor them: a reader
 * that is given a folder and not a home (a ferret's file index) would otherwise list `~/.ssh/config` and
 * `known_hosts` as ordinary files. `.claude`, `.codex` and `.docker` are NOT here — a project keeps its own, and that
 * is ordinary project content; those stay home-anchored in {@link PRIVATE_FOLDERS}.
 */
const SECRET_FOLDER_NAMES: ReadonlySet<string> = new Set(['.ssh', '.gnupg', '.password-store']);

/** Whether one folder name is a key store wherever it sits. */
export const isSecretFolderName = (name: string): boolean => SECRET_FOLDER_NAMES.has(foldName(name));
