import { BINARY_SNIFF_BYTES, FsError } from './types.ts';

/**
 * The pure path gates: the syntactic check every request meets first, and the unconditional denylist
 * applied to every path that names the bytes about to be served.
 *
 * These are deliberately string functions with no IO. They are gate 1 and gate 4 of the six the
 * subsystem applies, and they run BEFORE the filesystem is touched at all — which is the only reason
 * they are safe to express on names. Gate 2, containment, is a descriptor walk and lives behind the
 * root pinner port; nothing here is a substitute for it.
 */

/** Basenames and globs refused unconditionally, in content and in diff. */
const DENY_PATTERNS: readonly RegExp[] = [
  /^\.env$/i,
  /^\.env\..*$/i,
  /^secrets?\.ya?ml$/i,
  /^secrets?\.enc\.ya?ml$/i,
  /^secrets?\.json$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^id_ecdsa/i,
  /^id_dsa/i,
  /\.age$/i,
  /credentials.*\.json$/i,
  /\.kdbx$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.pgpass$/i,
  /^\.htpasswd$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /\.keystore$/i,
];

/**
 * Directories refused wholesale, at any depth.
 *
 * `.git` can embed credentialed remote URLs in `config` and its objects are useless in a viewer;
 * `node_modules` is pure noise and hundred-thousand-entry listings. Matched case-insensitively
 * because a macOS checkout is case-preserving but case-INsensitive, so `.GIT/config` opens the same
 * file as `.git/config`.
 */
const DENY_DIRECTORIES: readonly string[] = ['.git', 'node_modules'];

const NUL = String.fromCharCode(0);
const DELETE_CODE_POINT = 0x7f;
const LAST_C0_CODE_POINT = 0x1f;

/**
 * Any C0 control character or DEL.
 *
 * A code-point scan rather than a character class, because a regex literal holding control characters
 * is itself a lint error and escaping them into one buys nothing.
 */
function hasControlCharacter(raw: string): boolean {
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= LAST_C0_CODE_POINT || code === DELETE_CODE_POINT) return true;
  }
  return false;
}

/**
 * Validate an untrusted relative path BEFORE the filesystem sees it.
 *
 * Returns the normalised path (forward slashes, no trailing slash, `''` for the root). Rejects
 * anything that could mean "somewhere else": absolute paths, `..`, backslashes (a Windows-style
 * separator POSIX treats as a legal filename character, which would smuggle segments past this
 * check), NUL, control characters, and empty or `.` segments.
 */
export function normalizeRelativePath(input: string | undefined | null): string {
  const raw = input ?? '';
  if (raw === '' || raw === '.' || raw === './') return '';
  if (raw.includes(NUL)) throw new FsError('invalid_path', 'path may not contain NUL');
  if (raw.includes('\\')) throw new FsError('invalid_path', 'path may not contain backslashes');
  if (hasControlCharacter(raw)) throw new FsError('invalid_path', 'path may not contain control characters');
  if (raw.startsWith('/')) throw new FsError('invalid_path', 'path must be relative to the session root');

  const segments = raw.split('/');
  const cleaned: string[] = [];
  for (const [index, segment] of segments.entries()) {
    // A single trailing slash is the only empty segment tolerated.
    if (segment === '' && index === segments.length - 1 && index > 0) continue;
    if (segment === '' || segment === '.') throw new FsError('invalid_path', `path has an empty segment: "${raw}"`);
    if (segment === '..') throw new FsError('invalid_path', 'path may not contain ".." segments');
    cleaned.push(segment);
  }
  return cleaned.join('/');
}

/**
 * Is any segment of this path on the unconditional denylist?
 *
 * Every segment is checked, not just the leaf: `.git/config` and a directory named `foo.key` are both
 * refused, which is the safe direction to err in.
 */
export function isDeniedPath(rel: string): boolean {
  if (rel === '') return false;
  for (const segment of rel.split('/')) {
    const folded = segment.toLowerCase();
    if (DENY_DIRECTORIES.includes(folded)) return true;
    if (DENY_PATTERNS.some(pattern => pattern.test(segment))) return true;
  }
  return false;
}

/**
 * Is any DIRECTORY component of this absolute root one we never serve?
 *
 * The per-request gates judge paths relative to the session root, so a root that is itself inside a
 * denied directory would make every relative path innocent: with a cwd of `<repo>/.git`, the request
 * `config` has no denied segment at all, and a session may be started in any directory that exists.
 * Applied to the PINNED realpath, so a symlinked cwd cannot launder it either.
 *
 * The same segment policy as an ordinary request path: a cwd of `<repo>/.env/` would otherwise
 * launder that denied directory merely by making it the root, even though `.env/child` is refused when
 * reached from `<repo>`.
 *
 * Split on `/` rather than a platform separator because the pin is procfs-backed and therefore POSIX
 * by construction.
 */
export function rootIsDenied(rootReal: string): boolean {
  return isDeniedPath(rootReal.split('/').filter(Boolean).join('/'));
}

/** A NUL inside the sniff window means "do not try to render this as text". */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * Every path that names one target's bytes, deduplicated and with the root itself dropped.
 *
 * Judging only the LEXICAL path lets an in-root symlinked directory launder a denied or ignored
 * target: `alias -> .git` makes `alias/config` lexically innocent while it is canonically the object
 * store. The descriptor walk refuses interior symlinks outright, so the two paths agree — but the
 * gates must never DEPEND on that invariant holding, so both are always gated.
 */
export function gateCandidates(...paths: readonly (string | undefined)[]): readonly string[] {
  const candidates: string[] = [];
  for (const candidate of paths) {
    if (candidate === undefined || candidate === '') continue;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}
