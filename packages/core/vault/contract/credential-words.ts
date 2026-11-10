/**
 * What makes a name or a value read as a credential: the ONE list of secret-name words and well-known token formats,
 * shared by every plugin that has to refuse, hide or cut one (Runtimes' environment import and command-line words,
 * Catalogs' publish). It lives in the Vault contract because it is the vocabulary of "a secret that must live in the
 * secret store", and because a contract may import only contracts: a plugin that needs the rule cannot reach another
 * plugin's daemon code.
 *
 * Pure. It never repeats a value.
 */
import { MIN_SECRET_VALUE_LENGTH, secretReferencesIn } from './secrets.ts';

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
  if (value.length < MIN_SECRET_VALUE_LENGTH || pointsElsewhere(value)) return false;
  if (SECRET_VALUE_PREFIX.test(value)) return true;
  return secretNamed(name);
}

/** Whether a value only points at one (`$NAME`, `${NAME}`, a `${secret:NAME}` in it), and so holds none. */
export const pointsElsewhere = (value: string): boolean =>
  INDIRECT_VALUE.test(value) || secretReferencesIn(value).length > 0;

/** Whether a name says it holds a credential: a word such as `TOKEN`, or a pair such as `API_KEY` ({@link looksSecret}). */
export function secretNamed(name: string): boolean {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/u)
    .filter(Boolean);
  if (words.some(word => SECRET_NAME_WORDS.has(word))) return true;
  return words.some((word, index) => SECRET_NAME_PAIRS.has(`${word}_${words[index + 1] ?? ''}`));
}
