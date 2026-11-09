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

/**
 * A value that only points somewhere else: `$NAME`, `${NAME}` or `${secret:NAME}`. The braces take a NAME and nothing else,
 * so a key wrapped in braces (`${q7Zk…}` with a symbol, `${secret:lower-case-key}`) is not an indirection.
 */
const INDIRECT_VALUE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\}|\{secret:[A-Z][A-Z0-9_]{0,63}\})$/u;
const REFERENCE = INDIRECT_VALUE;

/** A whole value that is exactly one valid `${secret:NAME}` reference. */
const WHOLE_SECRET_REFERENCE = /^\$\{secret:[A-Z][A-Z0-9_]{0,63}\}$/u;

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
import { MIN_SECRET_VALUE_LENGTH, secretReferencePattern, secretReferencesIn } from '@ferretry/core-vault/contract';

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

/** One glued word that ends in a credential word (`GATEWAYTOKEN`, `MYAPIKEY`); a plain `…KEY` ending (`PORTKEY`) is not enough. */
const GLUED_CREDENTIAL_WORD = /(?:APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?$/u;

/** Name word pairs that say the same: `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `SECRET_KEY`. */
const SECRET_NAME_PAIRS: ReadonlySet<string> = new Set(['API_KEY', 'ACCESS_KEY', 'PRIVATE_KEY', 'SECRET_KEY']);

const TOKEN_BODY = '[A-Za-z0-9_-]{8,}';

/**
 * THE list of well-known token formats (one owner): each is a fixed prefix and the body that follows it. A
 * value that starts with a prefix is a secret by value ({@link looksSecret}), and text that holds a whole token
 * anywhere, glued to anything, is found ({@link hasTokenShape}). Every body is a linear class of a minimum
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
  // A PEM private key: the header alone is the shape (the body follows on later lines, or after an escaped `\n`).
  ['-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----', ''],
];

/** Value prefixes of well-known token formats, and of two more whose body is not a plain run (a Google OAuth token, a JWT). */
const SECRET_VALUE_PREFIX = new RegExp(`^(?:${TOKEN_FORMATS.map(([prefix]) => prefix).join('|')}|ya29\\.|eyJ)`, 'u');

/** A whole well-known token anywhere in a string, glued to anything, plus a Google OAuth token (a JWT is {@link holdsJwtShape}). */
const TOKEN_ANYWHERE = new RegExp(
  `${TOKEN_FORMATS.map(([prefix, body]) => `${prefix}${body}`).join('|')}|ya29\\.`,
  'u',
);

/**
 * Whether a string holds the start of a JWT anywhere: `eyJ`, a run of 8 or more base64url characters, then a `.`. Read by
 * hand rather than by a pattern, because a run that does not end in a dot would be re-read from every `eyJ` inside it
 * (quadratic); here each run is read once.
 */
function holdsJwtShape(value: string): boolean {
  let from = 0;
  for (;;) {
    const start = value.indexOf('eyJ', from);
    if (start < 0) return false;
    let end = start + 3;
    while (end < value.length && /[A-Za-z0-9_-]/u.test(value.charAt(end))) end += 1;
    if (end - (start + 3) >= 8 && value.charAt(end) === '.') return true;
    from = end;
  }
}

/**
 * Whether one environment entry looks like a secret (E7).
 *
 * By NAME (a word such as `TOKEN` or `API_KEY`) or by VALUE (a well-known token prefix). A value
 * that is only a reference to another variable is not a secret, because it holds none, and a value
 * shorter than the secret store accepts is a flag rather than a credential (`AUTH=1`).
 */
export function looksSecret(name: string, value: string): boolean {
  if (value.length < MIN_SECRET_VALUE_LENGTH) return false;
  if (INDIRECT_VALUE.test(value)) return hasTokenShape(value);
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
  // A last word KEY or KEYS (`AZURE_OPENAI_KEY`), or one glued word that ends in a credential word (`GATEWAYTOKEN`).
  const last = words.at(-1) ?? '';
  if (last === 'KEY' || last === 'KEYS' || words.some(word => GLUED_CREDENTIAL_WORD.test(word))) return true;
  return words.some((word, index) => SECRET_NAME_PAIRS.has(`${word}_${words[index + 1] ?? ''}`));
}

/** Whether a value starts like a well-known token (any length) or holds a whole one anywhere in it (`sk-…`, `ghp_…`, a JWT, `ya29.`), whatever the variable is called. */
export function hasTokenShape(value: string): boolean {
  return (
    SECRET_VALUE_PREFIX.test(value) ||
    TOKEN_ANYWHERE.test(value) ||
    holdsJwtShape(value) ||
    KNOWN_SHAPES.some(shape => shape.test(value))
  );
}

// ── the stored rule ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Under a CREDENTIAL NAME a value is accepted only when it is exactly one of a short list of shapes (an ALLOWLIST), so a
// key cannot hide in any text a blocklist forgot. Under ANY name a token shape, a credential-named header (in a header
// list) and a credential in an address are refused. Everything below is linear in the length of the value: no pattern
// has two classes that overlap around a repeated character, and each sub-check runs once per value.

/** A `${secret:NAME}` reference. One shared global pattern: `String.replace` resets its position, so sharing it is safe. */
const REFERENCE_PATTERN = secretReferencePattern();

/** One or more `${secret:NAME}` references and nothing between them. */
const REFERENCES_ONLY = /^(?:\$\{secret:[A-Z][A-Z0-9_]{0,63}\})+$/u;

/** A scheme word that may open a value, then the whitespace after it. */
const SCHEME_WORD = /^(?:bearer|basic|token)\s+/iu;

/** A header's name: letters, digits, `-` and `_`, at most 64 characters. */
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

/** The longest `-` or `_` word a header name may hold: a key does not fit in a header name. */
const MAX_HEADER_NAME_WORD = 16;

/** The most words a header name may have unless the name itself says it is a credential (`x-api-key`). */
const MAX_PLAIN_HEADER_NAME_WORDS = 3;

/** The address schemes a value under a credential name may open with: web, web socket and proxy ones. */
const ALLOWED_ADDRESS_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'ws', 'wss', 'socks5', 'socks5h']);

/** The shortest run of letters, digits and `_` that can be a key, and the entropy (bits per character) that makes it read as one. */
const MIN_KEY_RUN = 24;
const MIN_KEY_RUN_ENTROPY = 3.5;
const WORD_RUN = /[A-Za-z0-9_]+/gu;

/**
 * Whether a text holds a run of 24 or more letters, digits and `_` with entropy of at least 3.5 and a digit in it: the shape
 * of a random key, as opposed to a long word (`application_default_credentials`) or a dashed id (a GUID is runs of 12 or
 * fewer). `-`, `.`, `/`, `~` and every other character end a run. A whole `${secret:NAME}` is taken out first. Linear: each
 * run is read once.
 */
function holdsKeyRun(text: string): boolean {
  const bare = text.replace(REFERENCE_PATTERN, ' ');
  for (const [run] of bare.matchAll(WORD_RUN)) {
    if (run.length >= MIN_KEY_RUN && /[0-9]/u.test(run) && shannonEntropy(run) >= MIN_KEY_RUN_ENTROPY) return true;
  }
  return false;
}

/** Whether a header's value (after one scheme word, references taken out) has a token shape or a key run. */
function headerValueHoldsKey(value: string): boolean {
  const bare = value.trim().replace(SCHEME_WORD, '').replace(REFERENCE_PATTERN, ' ');
  return hasTokenShape(bare) || holdsKeyRun(bare);
}

/** `$NAME` or `${NAME}`: an environment variable's own name, upper case by POSIX convention. */
const ENVIRONMENT_REFERENCE = /^\$(?:\{[A-Z_][A-Z0-9_]{0,63}\}|[A-Z_][A-Z0-9_]{0,63})$/u;

/** A number of at most 12 digits (a timeout, a port, a token budget). */
const SMALL_NUMBER = /^[0-9]{1,12}$/u;

/** The words a flag or a mode is written with. */
const FLAG_WORDS: ReadonlySet<string> = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'oauth', 'none', 'apikey']);

/** The address scheme a whole-URL value opens with. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

/** Where one address ends and the next begins in free text. */
const ADDRESS_BREAK = /[\s"'`<>]+/u;

/** The characters a URL parser removes before it reads an address (WHATWG: ASCII tab, CR and LF). */
const PARSER_DROPPED = /[\t\r\n]/gu;

/** Placeholder for a whole `${secret:NAME}` while an address is read, so its `:` is not a separator. */
const REFERENCE_MARK = '\u0001';

/** A URL-decoded string, or the string as written when it does not decode. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

const isReferences = (text: string): boolean => REFERENCES_ONLY.test(text);

/** A scheme word, whitespace, then references only. */
function isSchemeThenReferences(text: string): boolean {
  const scheme = SCHEME_WORD.exec(text);
  return scheme !== null && isReferences(text.slice(scheme[0].length));
}

/** Allowed shapes (a) to (c): a placeholder under 8 characters with no `$`, references only, or a scheme word then references. */
function isPlaceholderOrReference(value: string): boolean {
  if (value.length < MIN_SECRET_VALUE_LENGTH && !value.includes('$')) return true;
  const trimmed = value.trim();
  return isReferences(trimmed) || isSchemeThenReferences(trimmed);
}

/** Allowed shape (d): a header name, `:` or `=`, optional whitespace, then references only or a scheme word and references. */
function isHeaderThenReference(text: string): boolean {
  const split = text.search(/[:=]/u);
  if (split < 1 || split > 64) return false;
  const name = text.slice(0, split);
  if (!HEADER_NAME.test(name)) return false;
  const words = name.split(/[-_]/u);
  // A key does not fit in a header name: a short word, and a name of a few words unless it names a credential itself.
  if (words.some(word => word.length > MAX_HEADER_NAME_WORD)) return false;
  if (words.length > MAX_PLAIN_HEADER_NAME_WORDS && !headerNamesACredential(name)) return false;
  const rest = text.slice(split + 1).trimStart();
  return isReferences(rest) || isSchemeThenReferences(rest);
}

/** Allowed shape (g): the whole value is one address that carries no user, password or key. */
function isCleanAddress(text: string): boolean {
  const scheme = URL_SCHEME.exec(text);
  if (scheme === null || /\s/u.test(text)) return false;
  if (!ALLOWED_ADDRESS_SCHEMES.has(scheme[0].slice(0, -3).toLowerCase())) return false;
  try {
    new URL(text);
  } catch {
    return false;
  }
  // No fragment; a query of `name=value` pairs whose values are each under 8 characters outside a reference; no key-like run
  // in the host, a path segment, a value or the user part (read as written and URL-decoded).
  if (text.includes('#') || !queryIsClean(text) || urlCarries(text) !== undefined) return false;
  return !holdsKeyRun(text.slice(scheme[0].length)) && !holdsKeyRun(decoded(text.slice(scheme[0].length)));
}

/** Whether an address's query (after the first `?`) is `name=value` pairs only, each value shorter than a key. */
function queryIsClean(text: string): boolean {
  const mark = text.indexOf('?');
  if (mark < 0) return true;
  return text
    .slice(mark + 1)
    .split(/[&;]/u)
    .every(pair => {
      if (pair === '') return true;
      const at = pair.indexOf('=');
      if (at < 1) return false;
      return decoded(pair.slice(at + 1)).replace(REFERENCE_PATTERN, '').length < MIN_SECRET_VALUE_LENGTH;
    });
}

/** Allowed shape (h): an absolute or `~/` path with no whitespace, no token shape and no key-like run (`GOOGLE_APPLICATION_CREDENTIALS`). */
function isPlainPath(text: string): boolean {
  return /^(?:\/|~\/)\S*$/u.test(text) && !hasTokenShape(text) && !holdsKeyRun(text) && !holdsKeyRun(decoded(text));
}

/**
 * THE allowlist: what a value under a credential-named variable may be, and nothing else.
 *
 * - (a) under 8 characters with no `$`: a placeholder (`ollama`, `dummy`, `hunter2`), shorter than the secret store accepts;
 * - (b) one `${secret:NAME}`, or several with nothing between them;
 * - (c) a scheme word (`Bearer`, `Basic`, `Token`) then whitespace then (b);
 * - (d) a header name, `:` or `=`, optional whitespace, then (b) or (c);
 * - (e) `$NAME` or `${NAME}`, NAME being an upper-case environment variable name;
 * - (f) a number of up to 12 digits, or a flag word (`true`, `oauth`, `none`…);
 * - (g) one `http`, `https`, `ws`, `wss`, `socks5` or `socks5h` address with no password, no user key, no fragment, only
 *   `name=value` query pairs with short values, and no key-like run anywhere in it;
 * - (h) an absolute or `~/` path with no whitespace, no token shape and no key-like run.
 */
function allowedUnderCredentialName(value: string): boolean {
  if (value.length < MIN_SECRET_VALUE_LENGTH && !value.includes('$')) return true;
  const trimmed = value.trim();
  if (isReferences(trimmed) || isSchemeThenReferences(trimmed) || isHeaderThenReference(trimmed)) return true;
  if (ENVIRONMENT_REFERENCE.test(trimmed) || SMALL_NUMBER.test(trimmed)) return true;
  if (trimmed.length <= 16 && FLAG_WORDS.has(trimmed.toLowerCase())) return true;
  return isCleanAddress(trimmed) || isPlainPath(trimmed);
}

/** The upper-case words of a variable's name. */
function nameWords(name: string): readonly string[] {
  return name
    .toUpperCase()
    .split(/[^A-Z0-9]+/u)
    .filter(Boolean);
}

/** Whether a variable holds a LIST of headers (`ANTHROPIC_CUSTOM_HEADERS`, `OTEL_EXPORTER_OTLP_HEADERS`, `GATEWAY_AUTH_HEADER`). */
function namesAHeaderList(name: string): boolean {
  return nameWords(name).some(word => word === 'HEADER' || word === 'HEADERS');
}

/** Whether a HEADER's name says its value is a credential: `Authorization`, `Proxy-Authorization`, `x-api-key`, `x-auth-token`, `cookie`. */
function headerNamesACredential(name: string): boolean {
  const read = name.replaceAll('-', '_');
  return /^(?:proxy_)?authorization$/iu.test(read) || namesACredential(read) || CREDENTIAL_KEY.test(read);
}

/** A line break followed by whitespace: the line that follows belongs to the one before. */
const FOLDED_LINE = /(?:\r\n|\r|\n)[ \t]+/gu;
const HEADER_BREAK = /\r\n|\n|\r|,/u;

/**
 * Whether a header list holds a credential-named header whose value is not a placeholder or a reference. A list is split on
 * line ends and `,` (after a folded line is joined to the one before), each piece on its first `:` or `=` (the OpenTelemetry
 * list is `name=value,name=value`), and both halves are URL-decoded.
 */
function headerListHoldsKey(value: string, named: boolean): boolean {
  // The `:` of a `${secret:NAME}` is not a separator: it is hidden while the list is split and put back in each piece.
  return value
    .replace(FOLDED_LINE, ' ')
    .replace(REFERENCE_PATTERN, reference => reference.replace(':', REFERENCE_MARK))
    .split(HEADER_BREAK)
    .some(masked => {
      const piece = masked.replaceAll(REFERENCE_MARK, ':');
      const split = masked.search(/[:=]/u);
      // An address, a path or a reference where a name should be (`${secret:U}:…`, `https:`) is no header.
      if (split < 1 || /[$/@]/u.test(piece.slice(0, split))) return false;
      const body = decoded(piece.slice(split + 1)).trim();
      if (headerNamesACredential(decoded(piece.slice(0, split)).trim()) && !isPlaceholderOrReference(body)) return true;
      // In a variable that IS a header list, a header whose name says nothing (`x-honeycomb-team`) still carries a key.
      return named && headerValueHoldsKey(body);
    });
}

/** Query parameter names that carry a credential without ending in a credential word. */
const SIGNING_PARAMETERS: ReadonlySet<string> = new Set([
  'sig',
  'signature',
  'auth',
  'authorization',
  'apikey',
  'pass',
  'pwd',
]);

/** Whether a query parameter's NAME (decoded, trimmed, a trailing `[]` dropped) says it carries a credential. */
function parameterNamesACredential(name: string): boolean {
  const trimmed = decoded(name).trim();
  const read = (trimmed.endsWith('[]') ? trimmed.slice(0, -2) : trimmed).toLowerCase().replaceAll('-', '_');
  return (
    SIGNING_PARAMETERS.has(read) || read.endsWith('signature') || CREDENTIAL_KEY.test(read) || namesACredential(read)
  );
}

/** Whether `a=b&c=d` (or `;`) holds a credential-named parameter whose value is 8 or more characters outside a reference. */
function parametersCarryKey(text: string): boolean {
  return text.split(/[&;]/u).some(pair => {
    const at = pair.indexOf('=');
    if (at < 1) return false;
    const value = decoded(pair.slice(at + 1));
    return (
      value.length >= MIN_SECRET_VALUE_LENGTH &&
      value.replace(REFERENCE_PATTERN, '').length >= MIN_SECRET_VALUE_LENGTH &&
      parameterNamesACredential(pair.slice(0, at))
    );
  });
}

/**
 * Whether the user and password part of an address holds a secret: ANY literal password (one that is exactly
 * `${secret:NAME}` is a reference), or a user that is a key (8 or more characters outside a reference) when there is no
 * password or a literally empty one. Without a scheme only `user:password@` counts, so an e-mail address is not an address.
 */
function userinfoHoldsSecret(userinfo: string, explicit: boolean): boolean {
  const marked = userinfo.replaceAll(REFERENCE_MARK, 'x').replace(REFERENCE_PATTERN, REFERENCE_MARK);
  const colon = marked.indexOf(':');
  if (colon < 0 && !explicit) return false;
  const password = colon < 0 ? '' : marked.slice(colon + 1);
  if (password.replaceAll(REFERENCE_MARK, '') !== '') return true;
  const user = colon < 0 ? marked : marked.slice(0, colon);
  return user.replaceAll(REFERENCE_MARK, '').length >= MIN_SECRET_VALUE_LENGTH;
}

/** What one address-like piece of text carries: a password or key as the user, or a key in a query or fragment. */
function addressCarries(token: string): 'userinfo' | 'query' | undefined {
  if (!/[@?#]/u.test(token)) return undefined;
  const opening = /^[A-Za-z][A-Za-z0-9+.-]*:[/\\]{1,2}/u.exec(token) ?? /^[/\\]{2}/u.exec(token);
  const rest = token.slice(opening?.[0].length ?? 0);
  const end = rest.search(/[/\\?#]/u);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf('@');
  if (at >= 0 && userinfoHoldsSecret(authority.slice(0, at), opening !== null)) return 'userinfo';
  if (end < 0) return undefined;
  const tail = rest.slice(end);
  const hash = tail.indexOf('#');
  const mark = tail.indexOf('?');
  const query = mark >= 0 && (hash < 0 || mark < hash) ? tail.slice(mark + 1, hash < 0 ? undefined : hash) : '';
  const fragment = hash >= 0 ? tail.slice(hash + 1) : '';
  return parametersCarryKey(query) || parametersCarryKey(fragment) ? 'query' : undefined;
}

/** The address that starts at the first `scheme://` inside a piece of text that does not begin with one (`a,https://…`). */
function embeddedAddress(token: string): string | undefined {
  const at = token.indexOf('://', 1);
  if (at < 1) return undefined;
  let start = at;
  while (start > 0 && /[A-Za-z0-9+.-]/u.test(token.charAt(start - 1))) start -= 1;
  return start === 0 ? undefined : token.slice(start);
}

/**
 * What an address in a value carries, wherever it sits and with or without a scheme (`https://…`, `http:/…`, `//host/…`,
 * `host/path?…`, `user:password@host`): a literal password, a user that is a key, or a query or fragment parameter that is
 * credential-named (`key`, `token`, `sig`, `pass`, any `…signature`) holding 8 or more characters outside a reference.
 * `?api-version=…` and `?key=${secret:K}` carry nothing. Linear: it reads each piece of text a fixed number of times.
 */
export function urlCarries(value: string): 'userinfo' | 'query' | undefined {
  // Read twice: as written, and as a URL parser reads it, which drops every tab, CR and LF (`alice:pa\nss@proxy` is one password).
  const asParsed = value.replace(PARSER_DROPPED, '');
  for (const text of asParsed === value ? [value] : [value, asParsed]) {
    for (const token of text.split(ADDRESS_BREAK)) {
      if (token === '') continue;
      const carried = addressCarries(token);
      if (carried !== undefined) return carried;
      const inside = embeddedAddress(token);
      const nested = inside === undefined ? undefined : addressCarries(inside);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/** Why a pasted value was not put in a plain field. */
export type WithheldReason = 'credential-name' | 'token-shape' | 'allow-empty' | 'url-userinfo' | 'url-query';

/** A pasted value for a plain field: taken as is, or withheld for a reason (never the value in a sentence). */
export type PlainPaste =
  | { readonly kind: 'take'; readonly value: string }
  | { readonly kind: 'withheld'; readonly reason: WithheldReason };

/** The last name word that says a variable IS a credential (`…_TOKEN`), as opposed to one that is about one (`…_AUTH`). */
const FINAL_CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'APIKEY',
  'CREDENTIAL',
  'CREDENTIALS',
  'COOKIE',
  'PAT',
]);

/**
 * Whether a variable's NAME ENDS in a credential word (`GATEWAY_TOKEN`) or pair (`ANTHROPIC_API_KEY`). Only the browser's
 * `'prefill'` mode uses it, to withhold such a name at any length: `AUTH` and `AUTHORIZATION` (`SKIP_BEDROCK_AUTH=1`) and a
 * credential word in the middle (`API_KEY_HELPER_TTL_MS`) name a flag or a setting, and stay on the allowlist.
 */
function namesACredentialAtEnd(name: string): boolean {
  const words = nameWords(name);
  const last = words.at(-1) ?? '';
  return FINAL_CREDENTIAL_WORDS.has(last) || SECRET_NAME_PAIRS.has(`${words.at(-2) ?? ''}_${last}`);
}

/**
 * THE rule for a value headed for a PLAIN field (one owner, shared by this browser's paste, the daemon's backstop
 * `assertNoRawSecrets` and a login FILE's schema; they refuse `credential-name`, `token-shape`, `url-userinfo` and
 * `url-query`). It returns the verdict, never the value in a sentence.
 *
 * 1. A variable the preset deliberately leaves empty keeps its `''`.
 * 2. Under a CREDENTIAL-NAMED variable (a credential word in any position) the value must be one of the allowlisted shapes
 *    ({@link allowedUnderCredentialName}); anything else is `credential-name`. In `'prefill'` (the browser's paste) a name that
 *    ENDS in a credential word takes only a whole `${secret:NAME}`, however short the value: the person types a placeholder
 *    themselves.
 * 3. Under ANY name, a variable that holds a header list (`…HEADERS`) is refused when a credential-named header in it
 *    (`Authorization`, `x-api-key`, `Cookie`…) has a value that is not a placeholder or a reference.
 * 4. Under ANY name, a token shape is never taken, at any length.
 * 5. Under ANY name, an address with a literal password, a key as the user, or a credential-named query or fragment
 *    parameter holding a key is not taken.
 */
export function plainPaste(
  name: string,
  value: string,
  allowEmpty: boolean,
  mode: 'prefill' | 'stored' = 'prefill',
): PlainPaste {
  if (value !== '') {
    const refusedByName =
      (namesACredential(name) && !allowedUnderCredentialName(value)) ||
      (mode === 'prefill' && namesACredentialAtEnd(name) && !WHOLE_SECRET_REFERENCE.test(value.trim())) ||
      headerListHoldsKey(value, namesAHeaderList(name));
    if (refusedByName) return { kind: 'withheld', reason: 'credential-name' };
    if (hasTokenShape(value)) return { kind: 'withheld', reason: 'token-shape' };
  }
  const carried = urlCarries(value);
  if (carried === 'userinfo') return { kind: 'withheld', reason: 'url-userinfo' };
  if (carried === 'query') return { kind: 'withheld', reason: 'url-query' };
  return allowEmpty ? { kind: 'withheld', reason: 'allow-empty' } : { kind: 'take', value };
}

/** What a value in a stored login's environment may NOT be: a secret (by name, shape or entropy), or an address holding one. */
export function storedEnvironmentIssue(name: string, value: string): 'secret' | 'userinfo' | 'query' | undefined {
  const plain = plainPaste(name, value, false, 'stored');
  if (plain.kind === 'withheld') {
    if (plain.reason === 'url-userinfo') return 'userinfo';
    if (plain.reason === 'url-query') return 'query';
    return 'secret';
  }
  // A credential-named variable was judged by the allowlist above; the entropy test covers the names it does not (`GATEWAY_KEY`).
  return !namesACredential(name) && looksLikeRawSecret(name, value) ? 'secret' : undefined;
}
