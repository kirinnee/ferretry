/**
 * The raw-secret detector: a configuration file may NEVER hold a secret value (docs/config-files.md).
 *
 * A secret lives in the secret store (`fy secret set NAME`) and a file names it as `${secret:NAME}`;
 * Ferretry puts the value into the one child process that needs it and nowhere else
 * (docs/secrets.md). A key pasted into a YAML file instead is readable by every editor of the
 * directory, copied by Clone and Export, and shown by "Edit as YAML" — so a file that holds one is
 * refused, exactly like a file that does not parse, and its last good version stays in effect.
 *
 * Two tests, either of which flags a value:
 *
 * 1. **A known key shape** anywhere in a string: `sk-`, `sk-ant-`, `sk-or-`, `AKIA…`, `ghp_`,
 *    `github_pat_`, `xox…-`, `gsk_`, `csk-`, `AIza…`, `glpat-`. These prefixes are what providers
 *    issue, so they are flagged under any key.
 * 2. **A high-entropy value under a key that names a credential** — `…KEY`, `…TOKEN`, `…SECRET`,
 *    `…PASSWORD`, `…CREDENTIAL(S)` — that is not a reference.
 *
 * WHAT IT NEVER DOES is repeat the value: an issue names where the value is and how to fix it, so a
 * secret that was pasted by mistake travels no further than the file it was pasted into.
 *
 * Pure: no IO.
 */

/** A located finding: the path to the value inside the document, never the value. */
export interface SecretFinding {
  readonly path: readonly (string | number)[];
}

/** What a person is told to do instead, in one sentence. */
export const RAW_SECRET_FIX =
  'store the value with `fy secret set NAME`, then write ${secret:NAME} here instead — a secret value never goes in a configuration file';

/** What the finding is, in one sentence that never includes the value. */
export const RAW_SECRET_MESSAGE = 'this looks like a raw secret (an API key or token)';

const KNOWN_SHAPES: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/u,
  /\bsk-or-[A-Za-z0-9_-]{8,}/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\bgsk_[A-Za-z0-9]{20,}/u,
  /\bcsk-[A-Za-z0-9]{20,}/u,
  /\bAIza[0-9A-Za-z_-]{30,}/u,
  /\bglpat-[A-Za-z0-9_-]{16,}/u,
];

/** A key whose value is a credential by its name. */
const CREDENTIAL_KEY = /(?:(?:key|token|secret|password|passwd)s?|credentials?)$/iu;

/** A value that names a secret rather than holding one: `${secret:NAME}`, `${NAME}` or `$NAME`. */
const REFERENCE = /^\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)$/u;

/** The shortest value the entropy test considers; shorter strings are words, not keys. */
const MIN_SECRET_LENGTH = 16;

/** Bits per character above which a value under a credential key reads as random. */
const ENTROPY_THRESHOLD = 3.5;

/** Shannon entropy of a string, in bits per character. */
export function shannonEntropy(value: string): number {
  const characters = [...value];
  const counts = new Map<string, number>();
  for (const character of characters) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / characters.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Whether `value`, found under `key`, looks like a raw secret. */
export function looksLikeRawSecret(key: string | number | undefined, value: string): boolean {
  if (KNOWN_SHAPES.some(shape => shape.test(value))) return true;
  if (typeof key !== 'string' || !CREDENTIAL_KEY.test(key)) return false;
  const trimmed = value.trim();
  if (REFERENCE.test(trimmed) || trimmed.length < MIN_SECRET_LENGTH || /\s/u.test(trimmed)) return false;
  // A path or a URL under a "…key" name (a key file, a JWKS endpoint) is where a secret is, not one.
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|[/~.])/iu.test(trimmed)) return false;
  return shannonEntropy(trimmed) >= ENTROPY_THRESHOLD;
}

/** Every string in `document` that looks like a raw secret, by path. */
export function findRawSecrets(document: unknown): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  const visit = (value: unknown, path: readonly (string | number)[]): void => {
    if (typeof value === 'string') {
      // The nearest KEY names the value — an item in a list under `api_keys:` is still a key.
      if (
        looksLikeRawSecret(
          path.findLast(part => typeof part === 'string'),
          value,
        )
      )
        findings.push({ path });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(item, [...path, index]);
      });
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
    }
  };
  visit(document, []);
  return findings;
}
