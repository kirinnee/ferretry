/**
 * The pure rules of the `project-files` root (§7.7, K3): what a manifest's `permissions.projectFiles` declares and which
 * names of ONE project folder it reaches. One fact, read by the real roots port (`../host/roots.ts`), the testing host
 * and the `plugin-graph` check, so a plugin's unit test meets exactly the refusals production makes.
 */

/** One literal segment of a `permissions.projectFiles` pattern: a plain name, never `.`/`..`, never a wildcard or NUL. */
const PATTERN_LITERAL = /^(?!\.{1,2}$)[A-Za-z0-9._+-]{1,255}$/u;

/**
 * Why a `permissions.projectFiles` pattern is refused, or `undefined` when it is legal. A pattern is a relative path of
 * `/`-separated segments: the FIRST is a literal name (never a wildcard, so no pattern reaches the whole folder), each
 * other is a literal or `*` (exactly one segment, any name), and the LAST may be `**` (everything below, at least one
 * entry). A leading or trailing `/`, an empty segment, `.`, `..`, NUL, a partial wildcard (`a*`) and a bare `**` are
 * refused.
 */
export function projectFilesPatternRefusal(pattern: unknown): string | undefined {
  if (typeof pattern !== 'string' || pattern === '') return 'a pattern is a non-empty string';
  if (pattern.includes('\0')) return 'a pattern has no NUL';
  if (pattern.startsWith('/')) return 'a pattern is relative, never absolute';
  const segments = pattern.split('/');
  for (const [index, segment] of segments.entries()) {
    if (segment === '') return 'a pattern has no empty segment (a leading, trailing or doubled "/")';
    if (segment === '.' || segment === '..') return 'a pattern has no "." or ".." segment';
    const last = index === segments.length - 1;
    if (segment === '**') {
      if (index === 0) return 'a pattern is never a bare "**" at the root';
      if (!last) return '"**" is only the last segment';
      continue;
    }
    if (segment === '*') {
      if (index === 0) return 'a pattern starts with a literal name, never "*"';
      continue;
    }
    if (!PATTERN_LITERAL.test(segment)) return `"${segment}" is not a plain name, "*" or "**"`;
  }
  return undefined;
}

/** What a `project-files` call does to a name, which decides how much of the declared set may reach it. */
export type ProjectUse =
  /** Read, write, publish or set the mode of a FILE. */
  | 'file'
  /** Make a folder (`mkdir -p`), or sync one: also the folders ABOVE a grant. */
  | 'make'
  /** Look at a name (`stat`, `lstat`, `realPath`): also the folders above a grant. */
  | 'probe'
  /** List a folder's names: only a folder a grant covers, never one above it. */
  | 'folder'
  /** Remove a name: a grant's own folder or file, or anything below. */
  | 'remove'
  /** Receive a copied folder, or be one copied from: a grant's own folder, or below it. */
  | 'tree';

/** The segments of one pattern: the part that names the grant, and whether everything below it is granted too. */
interface ParsedPattern {
  readonly grant: readonly string[];
  readonly deep: boolean;
}

const parsePatterns = (patterns: readonly string[] | undefined): readonly ParsedPattern[] =>
  (patterns ?? [])
    .filter(pattern => projectFilesPatternRefusal(pattern) === undefined)
    .map(pattern => {
      const segments = pattern.split('/');
      const deep = segments[segments.length - 1] === '**';
      return { grant: deep ? segments.slice(0, -1) : segments, deep };
    });

const segmentMatches = (pattern: string, name: string): boolean => (pattern === '*' ? name !== '' : pattern === name);

const startsWithGrant = (grant: readonly string[], names: readonly string[]): boolean =>
  grant.every((segment, index) => segmentMatches(segment, names[index] as string));

/**
 * The refusal for one root-relative name of a `project-files` handle, from the declared set alone (§7.7, K3):
 * `outside` for a name that is not a plain relative path (`''`, `.`, `..`, an empty segment, NUL), and
 * `not_declared` for a name the declared set does not reach for this use. Segments are compared EXACTLY (case
 * included), so `.CLAUDE/skills/x/a` is not `.claude/skills/x/a` on any disk. `undefined` when the use is allowed.
 *
 * For a pattern with `**` the GRANT is the folder before it (`.claude/skills/<name>`): that folder and everything below
 * it are reached, a FILE at the grant itself is not (the pattern wants something below it), and the folders above the
 * grant (`.claude`, `.claude/skills`) may only be made or looked at, never listed, read, written or removed. For a
 * pattern without it (`.mcp.json`) the grant is the one name, and a folder made of it is refused.
 */
export function projectPathRefusal(
  patterns: readonly string[] | undefined,
  relativePath: string,
  use: ProjectUse,
): 'outside' | 'not_declared' | undefined {
  if (typeof relativePath !== 'string' || relativePath === '' || relativePath.includes('\0')) return 'outside';
  const names = relativePath.split('/');
  if (names.some(name => name === '' || name === '.' || name === '..')) return 'outside';
  for (const { grant, deep } of parsePatterns(patterns)) {
    if (names.length < grant.length) {
      // Above the grant: a folder on the way to it, and only a folder.
      if (startsWithGrant(grant.slice(0, names.length), names) && (use === 'make' || use === 'probe')) return undefined;
      continue;
    }
    if (!startsWithGrant(grant, names)) continue;
    if (names.length > grant.length) {
      if (deep) return undefined;
      continue;
    }
    // At the grant itself.
    if (use === 'file' && deep) continue;
    if ((use === 'make' || use === 'tree') && !deep) continue;
    if (use === 'folder' && !deep) continue;
    return undefined;
  }
  return 'not_declared';
}

/**
 * The absolute folder a `project-files` handle is scoped to (`{ subfolder }`), or `undefined` when it is not exactly
 * that: absolute, no NUL, no `.`, `..` or empty segment (so no trailing `/`), and never the filesystem root.
 */
export function projectFilesScope(subfolder: string | undefined): string | undefined {
  if (typeof subfolder !== 'string' || !subfolder.startsWith('/') || subfolder.includes('\0')) return undefined;
  const segments = subfolder.slice(1).split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined;
  return subfolder;
}
