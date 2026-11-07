/**
 * "See changes" on this machine's own bytes, drawn so it cannot show a secret (docs/catalogs.md § See changes).
 *
 * The installed side is whatever a person typed or pasted into a skill folder or a server's environment, so it can
 * hold a password or a token. Instead of finding the secret and cutting it out (which needs a redactor that is
 * right about every spelling), an entry that MAY hold one is not drawn at all: it says it changed, that it is hidden,
 * and carries no text. Over-hiding is the accepted cost.
 *
 * The detector ({@link mayHoldSecret}) is broad and LINEAR: plain scans over the text, no backtracking pattern, and
 * a text over {@link MAX_SCANNED} is hidden unread. Nothing here runs the fleet's `redactText` on a publisher's
 * bytes. Pure.
 */
import {
  type CatalogChange,
  type CatalogChanges,
  type CatalogInstallWarning,
  catalogItemChanges,
  catalogItemReview,
  type DiffBudget,
  newDiffBudget,
  type SharedCatalogItem,
} from '../boundary.ts';

/** Longest text, in UTF-16 units, that is read at all; a longer one may hold a secret by definition. */
export const MAX_SCANNED = 2 * 1024 * 1024;

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
export const withoutInvisible = (text: string): string => text.replace(INVISIBLE, '');

/** `text` with its line breaks taken out, so a name or a value a line break split reads whole again. */
export const joinedLines = (text: string): string => text.replace(LINE_BREAKS, '');

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

export const HIDDEN_WARNING = 'Hidden: this may hold a secret. Open the item yourself to read it.';

const ENV_LABEL = 'Environment ';

/** Warning codes whose text carries a value of the item (an address, a registry, a package), not just file paths. */
const VALUE_WARNINGS: ReadonlySet<CatalogInstallWarning['code']> = new Set([
  'network-url',
  'package-registry',
  'unpinned-package',
]);

const safeWarning = (warning: CatalogInstallWarning): CatalogInstallWarning =>
  VALUE_WARNINGS.has(warning.code) && mayHoldSecret(warning.text) ? { ...warning, text: HIDDEN_WARNING } : warning;

const reviewTexts = (item: SharedCatalogItem): Map<string, string> =>
  new Map(catalogItemReview(item).map(entry => [entry.label, entry.text]));

/** A server's start line quotes an argument with a line break in it (it reads as \n), so each raw argument is read too. */
const startsHoldSecret = (item: SharedCatalogItem): boolean =>
  item.kind === 'mcp' && item.mcp.transport === 'command' && item.mcp.args.some(arg => mayHoldSecret(arg));

/** Labels whose text on either side may hold a secret; every server environment value is one, tripped or not. */
function hiddenLabels(onDisk: SharedCatalogItem, offered: SharedCatalogItem): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const side of [reviewTexts(onDisk), reviewTexts(offered)])
    for (const [label, text] of side) if (label.startsWith(ENV_LABEL) || mayHoldSecret(text)) hidden.add(label);
  if (startsHoldSecret(onDisk) || startsHoldSecret(offered)) hidden.add('Starts');
  return hidden;
}

/** The entry with its text left out: it changed, and a person must open it to see how. */
const hiddenEntry = (entry: CatalogChange): CatalogChange => ({
  label: entry.label,
  change: 'changed',
  document: entry.document,
  hidden: true,
  ...(entry.flag === undefined ? {} : { flag: entry.flag }),
});

/**
 * What changed between the installed copy (`onDisk`, rebuilt from this machine's bytes) and the `offered` item. An
 * entry either side of which {@link mayHoldSecret} (and every server environment value) is `changed` and `hidden`,
 * with no hunks, before or after; one that is the same on both sides stays unchanged, and every other entry is what
 * {@link catalogItemChanges} answers.
 */
export function conservativeChanges(
  onDisk: SharedCatalogItem,
  offered: SharedCatalogItem,
  budget: DiffBudget = newDiffBudget(),
): CatalogChanges {
  const hidden = hiddenLabels(onDisk, offered);
  const changes = catalogItemChanges(onDisk, offered, budget);
  return {
    ...changes,
    entries: changes.entries.map(entry => (hidden.has(entry.label) ? hiddenEntry(entry) : entry)),
    newWarnings: changes.newWarnings.map(safeWarning),
    goneWarnings: changes.goneWarnings.map(safeWarning),
  };
}
