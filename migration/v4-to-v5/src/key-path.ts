/**
 * How a key of an owner's document is said in a report or an error. A map key can be anything the owner typed, and a
 * credential written as a KEY (`sk-...: true`, or a list/mapping key whose text is its own content) would otherwise be
 * printed in the very sentence that is meant to name the problem. One rule, used by every site that prints a key path:
 * a segment is said only when it reads as a NAME; a segment that looks like a key is said as `<key>`.
 */

/** Provider key prefixes that are never a name: OpenAI/Anthropic, GitHub, Slack, AWS. */
const KEY_PREFIX = /^(?:sk-|sk-ant-|ghp_|gho_|github_pat_|xox|AKIA)/u;

/** Characters a token may use (the same alphabet as the credential rules in `v4/config.ts`). */
const TOKEN_ALPHABET = /^[A-Za-z0-9._~+/=-]+$/u;

/** A segment that looks like a key: a known provider prefix, or 20+ token-alphabet characters with a letter and a digit. */
export const looksLikeKey = (segment: string): boolean =>
  KEY_PREFIX.test(segment) ||
  (segment.length >= 20 && TOKEN_ALPHABET.test(segment) && /[A-Za-z]/u.test(segment) && /\d/u.test(segment));

/**
 * One key of a path, said only when it reads as a name: letters, digits, `_`, `.`, `-`, 1 to 64 characters, and not
 * key-shaped. A number (a list index) is said as is. Anything else (a list or mapping key reaches a path as the text of
 * its own content) is `<key>`.
 */
export function pathSegment(segment: PropertyKey): string {
  if (typeof segment === 'number') return String(segment);
  return typeof segment === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(segment) && !looksLikeKey(segment)
    ? segment
    : '<key>';
}

/** A whole path, segments joined by `.` (`(top)` for the root); each segment through {@link pathSegment}. */
export const keyPath = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? '(top)' : path.map(pathSegment).join('.');
