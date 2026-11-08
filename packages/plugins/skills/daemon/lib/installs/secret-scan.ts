/**
 * The secret scanner a local skill copy judges its files with: the part of the catalog installer's conservative-changes
 * scanner that does not read a catalog item. COPIED, not shared: Catalogs owns the other half, and a shared helper in
 * @ferretry/std would carry a Ferretry noun. Pure and linear.
 */
/** Longest text, in UTF-16 units, that is read at all; a longer one may hold a secret by definition. */
const MAX_SCANNED = 2 * 1024 * 1024;

/** A name that announces a secret, wherever it stands in a word (`api_key`, `apikey`, `X-Auth`, `passphrase`). */
const SECRET_WORDS = [
  'pass',
  'pwd',
  'secret',
  'token',
  'key',
  'auth',
  'cred',
  'bearer',
  'jwt',
  'cookie',
  'private',
  'signature',
  'dsn',
  'webhook',
] as const;

/** Prefixes of well-known tokens, matched wherever they stand. Lower case: the text is lowered first. */
const LOWER_PREFIXES = [
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'github_pat_',
  'sk-',
  'xox',
  'glpat-',
  'npm_',
  'hf_',
  '-----begin',
] as const;

/** The same, where case tells them from prose. */
const EXACT_PREFIXES = ['AKIA', 'ASIA', 'AIza', 'eyJ'] as const;

/** A run of base64, base64url or hex characters at least this long is a word that may be a secret. */
const LONG_WORD = 24;

/** An invisible format character as the review writes it (`⟨U+00AD⟩`, `revealHidden`), or as it stands in raw text. */
const INVISIBLE = /\p{Cf}|⟨U\+[0-9A-F]{4,6}⟩/gu;
const LINE_BREAKS = /[\r\n]+/gu;

function isWordCharacter(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 43 || // +
    code === 47 || // /
    code === 61 || // =
    code === 45 || // -
    code === 95 // _
  );
}

function hasLongWord(text: string): boolean {
  let run = 0;
  for (let index = 0; index < text.length; index += 1) {
    run = isWordCharacter(text.charCodeAt(index)) ? run + 1 : 0;
    if (run >= LONG_WORD) return true;
  }
  return false;
}

const isSpace = (code: number): boolean => code === 32 || (code >= 9 && code <= 13) || code === 0xa0;

/** Credentials written into an address (`scheme://user:pw@host`) or a word (`user:pw@host`). */
function hasUserInfo(text: string): boolean {
  let from = text.indexOf('://');
  while (from !== -1) {
    for (let index = from + 3; index < text.length; index += 1) {
      const character = text[index];
      if (character === '@') return true;
      if (character === '/' || character === '?' || character === '#' || isSpace(text.charCodeAt(index))) break;
    }
    from = text.indexOf('://', from + 3);
  }
  let colon = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isSpace(code)) colon = false;
    else if (code === 58) colon = true;
    else if (code === 64 && colon) return true;
  }
  return false;
}

function hasAny(text: string, needles: readonly string[]): boolean {
  for (const needle of needles) if (text.includes(needle)) return true;
  return false;
}

/**
 * A short flag that takes a credential: `-u user:pw`, `-a hunter2`, `-p hunter2`, or `-phunter2` (a `-p` with its
 * value attached, as `mysql` reads it). A flag with a word after it, or a `-p` with one attached.
 */
function hasCredentialFlag(text: string): boolean {
  let index = 0;
  let flag = '';
  while (index < text.length) {
    while (index < text.length && isSpace(text.charCodeAt(index))) index += 1;
    const start = index;
    while (index < text.length && !isSpace(text.charCodeAt(index))) index += 1;
    if (start === index) break;
    const word = text.slice(start, index);
    if (flag !== '') return true;
    if (word === '-u' || word === '-p' || word === '-a') flag = word;
    else if (word.length > 2 && word.startsWith('-p') && word[2] !== '-') return true;
  }
  return false;
}

/** `text` with its invisible format characters (and the `⟨U+00AD⟩` marks the review writes for them) taken out. */
const withoutInvisible = (text: string): string => text.replace(INVISIBLE, '');

/** `text` with its line breaks taken out, so a name or a value a line break split reads whole again. */
const joinedLines = (text: string): string => text.replace(LINE_BREAKS, '');

/** `text` as the scans read it: invisible characters out, and look-alike forms (full-width letters) folded to plain ones. */
export const foldedForScan = (text: string): string => withoutInvisible(text).normalize('NFKC');

/** Whether a NAME announces a secret, wherever in it the word stands (`api_key`, `apikey`, `X-Auth`, `passphrase`). */
export const namesSecret = (name: string): boolean => hasAny(name.toLowerCase(), SECRET_WORDS);

/** A well-known token is at least this long, prefix included (`ghp_` plus 36, `AKIA` plus 16, `sk-` plus 20 or more). */
const MIN_TOKEN_LENGTH = 20;
const TOKEN_TAIL = /^[A-Za-z0-9_-]+$/u;

/**
 * Whether `word` is, whole, a well-known token: one of the prefixes above, at least {@link MIN_TOKEN_LENGTH}
 * characters of letters, digits, `_` and `-`, and a digit in it (a hyphenated word that merely starts `sk-` is
 * prose). `-----BEGIN` is a key block, not a token, and is not here. Linear.
 */
export function isKnownTokenShape(word: string): boolean {
  if (word.length < MIN_TOKEN_LENGTH || !TOKEN_TAIL.test(word) || !/\d/u.test(word)) return false;
  const lower = word.toLowerCase();
  return (
    LOWER_PREFIXES.some(prefix => !prefix.startsWith('-') && lower.startsWith(prefix)) ||
    EXACT_PREFIXES.some(prefix => word.startsWith(prefix))
  );
}

/** Names, token prefixes and expansions: the things a line break or an invisible character can split. */
function trips(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    hasAny(lower, SECRET_WORDS) || hasAny(lower, LOWER_PREFIXES) || hasAny(text, EXACT_PREFIXES) || text.includes('${')
  );
}

/**
 * Whether `text` MAY hold a secret: a name that announces one, a well-known token prefix, a `${…}` expansion, a
 * word of 24 or more base64 or hex-like characters, credentials in an address, or a credential flag (`-u`, `-p`, `-a`
 * and a value). Broad on purpose; linear in the
 * text; a text over {@link MAX_SCANNED} is `true` without being read. Invisible format characters and line breaks
 * are taken out (and the `⟨U+00AD⟩` marks the review writes for them) and the names, prefixes and `${` tried again, so
 * one split by either is still seen, in raw text or in the text a person reads.
 */
export function mayHoldSecret(text: string): boolean {
  if (text.length > MAX_SCANNED) return true;
  if (trips(text) || hasLongWord(text) || hasUserInfo(text) || hasCredentialFlag(text)) return true;
  const unmarked = withoutInvisible(text);
  if (unmarked.length !== text.length && hasLongWord(unmarked)) return true;
  const joined = joinedLines(unmarked);
  if (joined.length !== text.length && trips(joined)) return true;
  const folded = foldedForScan(text);
  return folded !== unmarked && (trips(folded) || hasLongWord(folded));
}
