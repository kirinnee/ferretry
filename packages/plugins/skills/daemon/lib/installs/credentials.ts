/**
 * The narrow test that refuses a copy (docs/catalogs.md § Copying a skill from this machine). A skill file may
 * quote a password the person typed once: copied into another account or project it would become a credential
 * somewhere it was never meant to be, and the review must never draw it. These shapes are certain enough to
 * refuse on — an address with a password in it (`scheme://user:pass@host`), a long value assigned to a name that
 * announces a secret (`API_KEY=…`, `api_key = "…"`, `token: …`, `"token": "…"`), an `Authorization: Bearer …`
 * header, `curl -u user:pass`, a long credential in an address's query (`?token=…`, `&api_key=…`), a PEM private
 * key block, and a well-known token (`ghp_…`, `sk-…`, `xoxb-…`, `AKIA…`: the prefixes See changes owns). Anything
 * vaguer only WARNS (`mayHoldSecret`).
 *
 * The text is read the way "See changes" reads it (catalog-installs/conservative-changes.ts): invisible
 * characters out, look-alike forms folded (NFKC), the secret NAMES that file owns, and a second pass over the
 * lines joined so a name or a value a line break split is still found. It reports the LINE, never the value.
 * Pure and linear: plain scans (the text is cut into words once, the first `curl` is found once), and no pattern
 * that can backtrack: a run of quote marks is trimmed by a loop, not by `["']+$`, which is quadratic on `"""…x`.
 */
import { foldedForScan, isKnownTokenShape, namesSecret } from './secret-scan.ts';

const ASSIGNED_NAME = /^-{0,2}[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;
const MIN_VALUE_LENGTH = 16;
const ADDRESS_STOPS = new Set(['/', '?', '#', '"', "'", '<', '>', '`']);
const SCHEMES = new Set(['bearer', 'basic', 'token', 'digest']);
const LINE_END = /\r\n|[\r\n]/u;
const WORD = /\S+/gu;
const VALUE_START = new Set(['"', "'", '`']);
const VALUE_END = new Set(['"', "'", '`', ',', ';', '}', ')', ']']);
const NAME_START = new Set(['"', "'", '`', '{', '[', '(']);
const NAME_END = new Set(['"', "'", '`']);
const TOKEN_SPLIT = /[=:"'`,;(){}[\]<>@/&?.]/u;
const PEM_HEADER = /-----BEGIN (?:[A-Z0-9]{1,16} ){0,4}PRIVATE KEY(?: BLOCK)?-----/iu;

/** A value that points at a secret rather than holding one: `$VAR`, `${VAR}`, `<your key>`, `%VAR%`, `[…]`. */
const isReference = (value: string): boolean => /^[$<{[%]/u.test(value);

const isSpace = (character: string): boolean => character.trim() === '';

/** `word` without the characters of `starts` at its front and `ends` at its back: two loops, one pass. */
function trimmed(word: string, starts: ReadonlySet<string>, ends: ReadonlySet<string>): string {
  let from = 0;
  let to = word.length;
  while (from < to && starts.has(word.charAt(from))) from += 1;
  while (to > from && ends.has(word.charAt(to - 1))) to -= 1;
  return word.slice(from, to);
}

const bare = (word: string): string => trimmed(word, VALUE_START, VALUE_END);

const nameOf = (word: string): string => trimmed(word, NAME_START, NAME_END);

/**
 * Where a secret NAME that begins at `start` really starts when the text is lines joined with nothing between
 * them: a name glued to the end of the line before it ("one" + "API_KEY" = "oneAPI_KEY") begins at the latest line
 * start inside it that still names a secret. `start` itself when no line starts inside it.
 */
function nameBeginning(name: string, start: number, lineStarts: ReadonlySet<number>): number {
  for (let index = name.length - 1; index > 0; index -= 1) {
    if (lineStarts.has(start + index) && announcesSecret(name.slice(index))) return start + index;
  }
  return start;
}

/** How many opening marks (`"`, `{`, …) stand before the name in `word`. */
function leadingLength(word: string): number {
  let length = 0;
  while (length < word.length && NAME_START.has(word.charAt(length))) length += 1;
  return length;
}

/** Where in `text` an address with a password in it starts, or -1. */
function addressWithPassword(text: string): number {
  let from = text.indexOf('://');
  while (from !== -1) {
    const start = from + 3;
    for (let index = start; index < text.length; index += 1) {
      const character = text.charAt(index);
      if (isSpace(character) || ADDRESS_STOPS.has(character)) break;
      if (character !== '@') continue;
      const userInfo = text.slice(start, index);
      const colon = userInfo.indexOf(':');
      const password = colon === -1 ? '' : userInfo.slice(colon + 1);
      if (password !== '' && !isReference(password)) return from;
      break;
    }
    from = text.indexOf('://', start);
  }
  return -1;
}

const isLongValue = (value: string): boolean => value.length >= MIN_VALUE_LENGTH && !isReference(value);

const announcesSecret = (name: string): boolean => ASSIGNED_NAME.test(name) && namesSecret(name);

/** A path or an address after `name:` is prose about where a key lives, not the key (the address rule has its own test). */
const pointsAtAPlace = (value: string): boolean => /^[/~.]/u.test(value) || value.includes('://');

/** The value after a name: `Bearer`/`Basic` give way to the word after them, and a lone `=` or `:` is skipped. */
function valueAt(words: readonly string[], index: number): string {
  const first = bare(words[index] ?? '');
  if (first === '=' || first === ':') return valueAt(words, index + 1);
  const value = first.startsWith('=') || first.startsWith(':') ? first.slice(1) : first;
  return SCHEMES.has(value.toLowerCase()) ? bare(words[index + 1] ?? '') : value;
}

/** Whether the word at `index` names a secret and is given a long value, in any of the spellings above. */
function assignsSecret(words: readonly string[], index: number): boolean {
  const word = words[index] ?? '';
  const at = word.search(/[:=]/u);
  if (at < 1) {
    const next = words[index + 1] ?? '';
    return (
      (next.startsWith('=') || next.startsWith(':')) &&
      announcesSecret(nameOf(word)) &&
      isLongValue(valueAt(words, index + 1))
    );
  }
  const name = nameOf(word.slice(0, at));
  const rest = bare(word.slice(at + 1));
  const value =
    rest === '' ? valueAt(words, index + 1) : SCHEMES.has(rest.toLowerCase()) ? valueAt(words, index + 1) : rest;
  if (!announcesSecret(name) || !isLongValue(value)) return false;
  return word.charAt(at) === '=' || !pointsAtAPlace(value);
}

/** `curl -u user:pass`, `curl --user user:pass`: a flag that carries a password, after a word that says `curl`. */
function curlUser(words: readonly string[], index: number, curlAt: number): boolean {
  const flag = bare(words[index] ?? '');
  if (flag !== '-u' && flag !== '--user') return false;
  if (curlAt === -1 || curlAt >= index) return false;
  const login = bare(words[index + 1] ?? '');
  const password = login.slice(login.indexOf(':') + 1);
  return login.includes(':') && password !== '' && !isReference(password);
}

/** Where in `word` a credential in an address's query starts (the parameter name): `?token=…`, `&api_key=…`; or -1. */
function queryCredential(word: string, wordStart: number, lineStarts: ReadonlySet<number>): number {
  const query = word.indexOf('?');
  if (query === -1) return -1;
  let start = query + 1;
  for (const parameter of word.slice(start).split('&')) {
    const equals = parameter.indexOf('=');
    if (equals > 0 && announcesSecret(parameter.slice(0, equals)) && isLongValue(bare(parameter.slice(equals + 1)))) {
      return nameBeginning(parameter.slice(0, equals), wordStart + start, lineStarts);
    }
    start += parameter.length + 1;
  }
  return -1;
}

/** Where in `word` a well-known token starts, alone or after `=`, `:`, a quote or a slash; or -1. */
function holdsToken(word: string): number {
  let start = 0;
  for (const part of word.split(TOKEN_SPLIT)) {
    if (isKnownTokenShape(part)) return start;
    start += part.length + 1;
  }
  return -1;
}

/** Where in the text the credential the word at `index` holds STARTS (its name, its token, its flag), or -1. */
function wordCredential(
  words: readonly string[],
  index: number,
  curlAt: number,
  wordStart: number,
  lineStarts: ReadonlySet<number>,
): number {
  const word = words[index] ?? '';
  if (assignsSecret(words, index)) {
    const opening = leadingLength(word);
    const at = word.search(/[:=]/u);
    const name = nameOf(at < 1 ? word : word.slice(0, at));
    return nameBeginning(name, wordStart + opening, lineStarts);
  }
  if (curlUser(words, index, curlAt)) return wordStart;
  const inQuery = queryCredential(word, wordStart, lineStarts);
  if (inQuery !== -1) return inQuery;
  const inToken = holdsToken(word);
  return inToken === -1 ? -1 : wordStart + inToken;
}

function earliest(offsets: readonly number[]): number {
  const found = offsets.filter(at => at !== -1);
  return found.length === 0 ? -1 : Math.min(...found);
}

/** Where in `text` the first credential starts, or -1. */
function credentialOffset(text: string, lineStarts: ReadonlySet<number> = new Set()): number {
  const found = [...text.matchAll(WORD)];
  const words = found.map(match => match[0]);
  const curlAt = words.findIndex(word => bare(word).toLowerCase().endsWith('curl'));
  let hit = -1;
  for (let index = 0; index < words.length && hit === -1; index += 1) {
    hit = wordCredential(words, index, curlAt, found[index]?.index ?? 0, lineStarts);
  }
  return earliest([hit, addressWithPassword(text), text.search(PEM_HEADER)]);
}

/** The 1-based line that holds offset `at` of the lines joined with one space between them. */
function lineAt(lines: readonly string[], at: number): number {
  let end = 0;
  return (
    lines.findIndex(line => {
      end += line.length + 1;
      return end > at;
    }) + 1
  );
}

/** Where each line begins in the lines joined with nothing between them (never decreasing: a blank line shares its successor's). */
function startsOf(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let end = 0;
  for (const line of lines) {
    starts.push(end);
    end += line.length;
  }
  return starts;
}

/** The 1-based line holding offset `at`: the last line that starts at or before it. */
function lineHolding(starts: readonly number[], at: number): number {
  let from = 0;
  let to = starts.length - 1;
  while (from < to) {
    const middle = Math.ceil((from + to) / 2);
    if ((starts[middle] ?? 0) <= at) from = middle;
    else to = middle - 1;
  }
  return from + 1;
}

/** The 1-based line of the first password or key in `text`, or undefined when there is none. */
export function firstCredentialLine(text: string): number | undefined {
  const lines = foldedForScan(text).split(LINE_END);
  const own = lines.findIndex(line => credentialOffset(line) !== -1);
  if (own !== -1) return own + 1;
  // A value on the next line (YAML), then a name or value a line break split: the line the credential STARTS on.
  const spaced = credentialOffset(lines.join(' '));
  if (spaced !== -1) return lineAt(lines, spaced);
  const starts = startsOf(lines);
  const glued = credentialOffset(lines.join(''), new Set(starts));
  return glued === -1 ? undefined : lineHolding(starts, glued);
}
