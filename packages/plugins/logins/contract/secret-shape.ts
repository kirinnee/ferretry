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
/** An origin key: 16 random bytes in base32 (today's protocol pattern). */
const ORIGIN_KEY_PATTERN = /^[a-z2-7]{26}$/u;

/** A located finding: the path to the value inside the document, never the value. */
export interface SecretFinding {
  readonly path: readonly (string | number)[];
}

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
function shannonEntropy(value: string): number {
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

/**
 * `clonedFromKey` holds an origin key: 16 random bytes that name an item across two machines. It ends in
 * "key" and reads as random, but it opens nothing — it is an identifier, not a credential. It is only
 * ever the item's own top-level field, so only a value found there is exempt ({@link LooksLikeOptions}).
 */
const ORIGIN_KEY_FIELD = 'clonedFromKey';

export interface LooksLikeOptions {
  /** `key` is a field of the item itself, not of anything nested inside it (an `env` map, say). */
  readonly topLevel?: boolean;
}

/** Whether `value`, found under `key`, looks like a raw secret. */
export function looksLikeRawSecret(
  key: string | number | undefined,
  value: string,
  options: LooksLikeOptions = {},
): boolean {
  if (KNOWN_SHAPES.some(shape => shape.test(value))) return true;
  if (typeof key !== 'string' || !CREDENTIAL_KEY.test(key)) return false;
  if (options.topLevel === true && key === ORIGIN_KEY_FIELD && ORIGIN_KEY_PATTERN.test(value)) return false;
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
          { topLevel: path.length === 1 },
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

// ── looksSecret: one environment entry that looks like a secret (today's account import rule) ──
import { MIN_SECRET_VALUE_LENGTH, secretReferencesIn } from '@ferretry/core-vault/contract';

/** Name words that say a variable holds a credential. Matched per `_`-separated word. */
const SECRET_NAME_WORDS: ReadonlySet<string> = new Set([
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'APIKEY',
  'CREDENTIAL',
  'CREDENTIALS',
  'AUTH',
  'AUTHORIZATION',
  'COOKIE',
  'PAT',
]);

/** Name word pairs that say the same: `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `SECRET_KEY`. */
const SECRET_NAME_PAIRS: ReadonlySet<string> = new Set(['API_KEY', 'ACCESS_KEY', 'PRIVATE_KEY', 'SECRET_KEY']);

const TOKEN_BODY = '[A-Za-z0-9_-]{8,}';

/**
 * THE list of well-known token formats (one owner): each is a fixed prefix and the body that follows it. A
 * value that starts with a prefix is a secret by value ({@link looksSecret}), and text that holds a whole token
 * anywhere, glued to anything, is cut ({@link SECRET_TOKEN_SOURCE}). Every body is a linear class of a minimum
 * length and no format looks behind it: `<&ghp_x` and `{sk-x` are cut as `ghp_x` and `sk-x` are. A new format
 * is added here and nowhere else.
 */
const TOKEN_FORMATS: readonly (readonly [prefix: string, body: string])[] = [
  ['sk-', TOKEN_BODY],
  ['sk_live_', TOKEN_BODY],
  ['gh[pousr]_', TOKEN_BODY],
  ['github_pat_', TOKEN_BODY],
  ['glpat-', TOKEN_BODY],
  ['xox[abposr]-', TOKEN_BODY],
  ['(?:AKIA|ASIA)', '[A-Z0-9]{16}'],
  ['AIza', TOKEN_BODY],
  ['npm_', TOKEN_BODY],
  ['hf_', TOKEN_BODY],
];

/** Value prefixes of well-known token formats, and of two more whose body is not a plain run (a Google OAuth token, a JWT). */
const SECRET_VALUE_PREFIX = new RegExp(`^(?:${TOKEN_FORMATS.map(([prefix]) => prefix).join('|')}|ya29\\.|eyJ)`, 'u');

/** A value that only points somewhere else: `$NAME`, `${NAME}`, `${secret:NAME}`. */
const INDIRECT_VALUE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})$/u;

/**
 * Whether one environment entry looks like a secret (E7).
 *
 * By NAME (a word such as `TOKEN` or `API_KEY`) or by VALUE (a well-known token prefix). A value
 * that is only a reference to another variable is not a secret, because it holds none, and a value
 * shorter than the secret store accepts is a flag rather than a credential (`AUTH=1`).
 */
export function looksSecret(name: string, value: string): boolean {
  if (value.length < MIN_SECRET_VALUE_LENGTH || INDIRECT_VALUE.test(value)) return false;
  if (secretReferencesIn(value).length > 0) return false;
  return SECRET_VALUE_PREFIX.test(value) || namesACredential(name);
}

/** Whether a variable's NAME says it holds a credential (`API_KEY`, `…_TOKEN`, `AUTH`), whatever its value is. */
export function namesACredential(name: string): boolean {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/u)
    .filter(Boolean);
  if (words.some(word => SECRET_NAME_WORDS.has(word))) return true;
  return words.some((word, index) => SECRET_NAME_PAIRS.has(`${word}_${words[index + 1] ?? ''}`));
}

/** Whether a value starts like a well-known token (`sk-…`, `ghp_…`, a JWT), whatever the variable is called. */
export function hasTokenShape(value: string): boolean {
  return SECRET_VALUE_PREFIX.test(value) || KNOWN_SHAPES.some(shape => shape.test(value));
}

/** What is wrong with a URL held as a plain value: a user and password in it, or a query string. */
export function urlCarries(value: string): 'userinfo' | 'query' | undefined {
  const rest = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^#]*)/iu.exec(value.trim());
  if (rest === null) return undefined;
  if ((rest[1] ?? '').includes('@')) return 'userinfo';
  return (rest[2] ?? '').includes('?') ? 'query' : undefined;
}

/** Why a pasted value was not put in a plain field. */
export type WithheldReason = 'credential-name' | 'token-shape' | 'allow-empty' | 'url-userinfo' | 'url-query';

/** A pasted value for a plain field: taken as is, or withheld for a reason (never the value in a sentence). */
export type PlainPaste =
  | { readonly kind: 'take'; readonly value: string }
  | { readonly kind: 'withheld'; readonly reason: WithheldReason };

/**
 * THE rule for a pasted value headed for a PLAIN field (one owner, shared by this browser's paste and the daemon's
 * backstop): a variable the preset deliberately leaves empty keeps its `''` (a pasted value is not taken, and a credential is still named); a credential-named variable or a value
 * with a token shape is never taken, however short; a URL with a user or a query string is not taken. It returns the
 * verdict, never the value in a sentence.
 */
export function plainPaste(name: string, value: string, allowEmpty: boolean): PlainPaste {
  if (value !== '' && !INDIRECT_VALUE.test(value) && secretReferencesIn(value).length === 0) {
    if (namesACredential(name)) return { kind: 'withheld', reason: 'credential-name' };
    if (hasTokenShape(value)) return { kind: 'withheld', reason: 'token-shape' };
  }
  const carried = urlCarries(value);
  if (carried === 'userinfo') return { kind: 'withheld', reason: 'url-userinfo' };
  if (carried === 'query') return { kind: 'withheld', reason: 'url-query' };
  return allowEmpty ? { kind: 'withheld', reason: 'allow-empty' } : { kind: 'take', value };
}
