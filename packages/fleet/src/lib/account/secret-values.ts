/**
 * Whether a value looks like a secret (E7, K4): THE one rule every reader of a person's own
 * environment applies — the first-run import of a settings file, and the provider a login shell is set
 * up for (`./provider-findings.ts`) — before anything is shown, written or kept as plain text.
 *
 * Pure.
 */
import { MIN_SECRET_VALUE_LENGTH, secretReferencesIn } from '@ferretry/protocol';

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

/** The regular expression source of any whole token in a text; a caller builds it with the `g` and `u` flags. */
export const SECRET_TOKEN_SOURCE: string = TOKEN_FORMATS.map(([prefix, body]) => `${prefix}${body}`).join('|');

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
  if (SECRET_VALUE_PREFIX.test(value)) return true;
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/u)
    .filter(Boolean);
  if (words.some(word => SECRET_NAME_WORDS.has(word))) return true;
  return words.some((word, index) => SECRET_NAME_PAIRS.has(`${word}_${words[index + 1] ?? ''}`));
}
