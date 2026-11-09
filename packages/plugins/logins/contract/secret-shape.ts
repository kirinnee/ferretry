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
];

/** Value prefixes of well-known token formats, and of two more whose body is not a plain run (a Google OAuth token, a JWT). */
const SECRET_VALUE_PREFIX = new RegExp(`^(?:${TOKEN_FORMATS.map(([prefix]) => prefix).join('|')}|ya29\\.|eyJ)`, 'u');

/** A whole well-known token anywhere in a string, glued to anything, plus a JWT and a Google OAuth token. */
const TOKEN_ANYWHERE = new RegExp(
  `${TOKEN_FORMATS.map(([prefix, body]) => `${prefix}${body}`).join('|')}|eyJ[A-Za-z0-9_-]{8,}\\.|ya29\\.`,
  'u',
);

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
  return words.some((word, index) => SECRET_NAME_PAIRS.has(`${word}_${words[index + 1] ?? ''}`));
}

/** Whether a value starts like a well-known token (any length) or holds a whole one anywhere in it (`sk-…`, `ghp_…`, a JWT, `ya29.`), whatever the variable is called. */
export function hasTokenShape(value: string): boolean {
  return SECRET_VALUE_PREFIX.test(value) || TOKEN_ANYWHERE.test(value) || KNOWN_SHAPES.some(shape => shape.test(value));
}

/** Query parameter names that carry a credential without ending in a credential word. */
const SIGNING_PARAMETERS: ReadonlySet<string> = new Set(['sig', 'signature', 'auth', 'authorization', 'apikey']);

/** Whether a query parameter's NAME says it carries a credential (`key`, `api_key`, `access_token`, `sig`, `password`). */
function parameterNamesACredential(name: string): boolean {
  const read = name.toLowerCase().replaceAll('-', '_');
  return SIGNING_PARAMETERS.has(read) || CREDENTIAL_KEY.test(read) || namesACredential(read);
}

/** Whether a query string carries a credential-named parameter whose value holds a key. */
function queryCarriesKey(query: string): boolean {
  return query.split(/[&;]/u).some(pair => {
    const at = pair.indexOf('=');
    if (at < 1) return false;
    let value = pair.slice(at + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // an undecodable value is judged as written
    }
    return parameterNamesACredential(pair.slice(0, at)) && holdsAKey(value);
  });
}

/** Whether the user and password part of an address holds a password, or a key as the user alone. A `${secret:NAME}` password is a reference. */
function userinfoHoldsSecret(userinfo: string): boolean {
  const bare = userinfo.replace(secretReferencePattern(), '');
  const colon = bare.indexOf(':');
  if (colon >= 0) return bare.slice(colon + 1) !== '';
  return holdsAKey(userinfo);
}

/**
 * What is wrong with a URL held as a plain value: a user and password in it (a password that is a `${secret:NAME}` reference is
 * not one), or a query string whose credential-named parameter (`key`, `token`, `sig`…) holds a key. `?api-version=…` is neither.
 */
export function urlCarries(value: string): 'userinfo' | 'query' | undefined {
  const trimmed = value.trim();
  const rest = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^#]*)/iu.exec(trimmed);
  if (rest === null) {
    const bare = /^([^/\s]+:[^/\s]*)@/u.exec(trimmed);
    return bare !== null && userinfoHoldsSecret(bare[1] ?? '') ? 'userinfo' : undefined;
  }
  const authority = rest[1] ?? '';
  const at = authority.lastIndexOf('@');
  if (at >= 0 && userinfoHoldsSecret(authority.slice(0, at))) return 'userinfo';
  const target = rest[2] ?? '';
  const mark = target.indexOf('?');
  return mark >= 0 && queryCarriesKey(target.slice(mark + 1)) ? 'query' : undefined;
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
 * credential word in the middle (`API_KEY_HELPER_TTL_MS`) name a flag or a setting, and stay on the length rule.
 */
function namesACredentialAtEnd(name: string): boolean {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/u)
    .filter(Boolean);
  const last = words.at(-1) ?? '';
  return FINAL_CREDENTIAL_WORDS.has(last) || SECRET_NAME_PAIRS.has(`${words.at(-2) ?? ''}_${last}`);
}

/** One header line: its name, then its value. */
const HEADER_LINE = /^\s*([A-Za-z][A-Za-z0-9-]{0,39})\s*:\s*(.*)$/u;

/** A scheme word that may open a header's value. */
const SCHEME_WORD = /^(?:bearer|basic|token)\b\s*/iu;

/** Whether a HEADER's name says its value is a credential: `Authorization`, `Proxy-Authorization`, `x-api-key`, `x-auth-token`, `cookie`. */
function headerNamesACredential(name: string): boolean {
  const read = name.replaceAll('-', '_');
  return /^(?:proxy_)?authorization$/iu.test(read) || namesACredential(read) || CREDENTIAL_KEY.test(read);
}

/** What a value leaves once its `${secret:NAME}` references, one credential `Header-Name:`, one scheme word and separators are taken away. */
function outsideReferences(value: string): string {
  const bare = value.replace(secretReferencePattern(), ' ').trim();
  const header = HEADER_LINE.exec(bare);
  const unheaded = header !== null && headerNamesACredential(header[1] ?? '') ? (header[2] ?? '') : bare;
  return unheaded.replace(SCHEME_WORD, '').replace(/[\s"',;:]/gu, '');
}

/**
 * Whether a value holds something key-like. With no reference it is any value of 8 characters or more (the secret store's
 * floor, so a shorter one is a placeholder such as `ollama`). With a `${secret:NAME}` in it, only what is LEFT counts: one
 * header name, one scheme word and separators may surround the reference, but 8 other characters beside it are a raw key.
 */
function holdsAKey(value: string): boolean {
  if (secretReferencesIn(value).length === 0) return value.length >= MIN_SECRET_VALUE_LENGTH;
  return outsideReferences(value).length >= MIN_SECRET_VALUE_LENGTH;
}

/** Whether any LINE of a value is a credential-named header (`Authorization`, `x-api-key`…) whose value holds a key. */
function holdsAHeaderKey(value: string): boolean {
  return value.split(/\r?\n/u).some(line => {
    const header = HEADER_LINE.exec(line);
    return (
      header !== null &&
      headerNamesACredential(header[1] ?? '') &&
      holdsAKey((header[2] ?? '').replace(SCHEME_WORD, ''))
    );
  });
}

/**
 * THE rule for a value headed for a PLAIN field (one owner, shared by this browser's paste and the daemon's
 * backstop `assertNoRawSecrets`, which refuses `credential-name`, `token-shape`, `url-userinfo` and `url-query`): a variable the
 * preset deliberately leaves empty keeps its `''`; a value with a token shape is never taken, at any length. In
 * `'prefill'` (the browser's paste) a variable whose name ENDS in a credential word is never taken either, however
 * short, and the person types a placeholder themselves. In both modes a credential-named variable (a credential word in
 * any position) is refused when its value holds 8 or more characters outside any `${secret:NAME}` reference, so only a
 * scheme word (`Bearer`, `Basic`, `Token`) and header punctuation (`Authorization:`) may surround a reference. A credential-named HEADER line (`Authorization: Bearer …`, `x-api-key: …`) is judged the same way, whatever the variable is called. A URL with a user and password (not a `${secret:NAME}` one), or a credential-named query parameter holding a key, is not taken. A whole `${…}` or `$NAME` that is not a valid `${secret:NAME}` is not taken under a credential-named variable in `'prefill'`. It returns
 * the verdict, never the value in a sentence.
 */
export function plainPaste(
  name: string,
  value: string,
  allowEmpty: boolean,
  mode: 'prefill' | 'stored' = 'prefill',
): PlainPaste {
  if (value !== '') {
    const indirect = INDIRECT_VALUE.test(value.trim());
    const namesOne = namesACredential(name) && holdsAKey(value);
    const atEnd = mode === 'prefill' && namesACredentialAtEnd(name);
    const wrongIndirect =
      indirect && mode === 'prefill' && namesACredential(name) && !WHOLE_SECRET_REFERENCE.test(value.trim());
    if ((!indirect && (namesOne || atEnd || holdsAHeaderKey(value))) || wrongIndirect) {
      return { kind: 'withheld', reason: 'credential-name' };
    }
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
  const secretShaped =
    plain.kind === 'withheld' && (plain.reason === 'credential-name' || plain.reason === 'token-shape');
  if (secretShaped || looksSecret(name, value) || looksLikeRawSecret(name, value)) return 'secret';
  return urlCarries(value);
}
