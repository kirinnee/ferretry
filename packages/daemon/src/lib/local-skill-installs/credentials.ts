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
import { foldedForScan, isKnownTokenShape, namesSecret } from '../catalog-installs/conservative-changes.ts';

const ASSIGNED_NAME = /^-{0,2}[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;
const MIN_VALUE_LENGTH = 16;
const ADDRESS_STOPS = new Set(['/', '?', '#', '"', "'", '<', '>', '`']);
const SCHEMES = new Set(['bearer', 'basic', 'token', 'digest']);
const LONGEST_SCHEME = Math.max(...[...SCHEMES].map(scheme => scheme.length));
const LINE_END = /\r\n|[\r\n]/u;
const WORD = /\S+/gu;
const VALUE_START = new Set(['"', "'", '`']);
const VALUE_END = new Set(['"', "'", '`', ',', ';', '}', ')', ']']);
const NAME_START = new Set(['"', "'", '`', '{', '[', '(']);
const NAME_END = new Set(['"', "'", '`']);
const TOKEN_SPLIT = /[=:"'`,;(){}[\]<>@/&?.]/u;
const PEM_HEADER = /-----BEGIN (?:[A-Z0-9]{1,16} ){0,4}PRIVATE KEY(?: BLOCK)?-----/iu;

/** `%NAME%`, whole: a percent sign that starts a URL escape (`%64…`) or a password is not a reference to anything. */
const WHOLE_PERCENT_REFERENCE = /^%[A-Za-z_][A-Za-z0-9_]{0,127}%$/u;
/** The longest reference {@link WHOLE_PERCENT_REFERENCE} accepts, so a caller can look at no more than that. */
const REFERENCE_LENGTH = 130;

/** A value that points at a secret rather than holding one: `$VAR`, `${VAR}`, `<your key>`, `%VAR%`, `[…]`. */
const isReference = (value: string): boolean => /^[$<{[]/u.test(value) || WHOLE_PERCENT_REFERENCE.test(value);

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

/** A word and where it starts in the text. */
interface Word {
  readonly text: string;
  readonly at: number;
}

const FLAG_VALUE = /^--?[A-Za-z][A-Za-z0-9-]*=(?=.)/u;

/** `--header={"k":"v"}` is two words to read, the flag and what it is given, so the value is read as a word of its own. */
function splitAtFlagValue(match: RegExpMatchArray): Word[] {
  const text = match[0];
  const at = match.index ?? 0;
  const flag = FLAG_VALUE.exec(text);
  if (flag === null) return [{ text, at }];
  return [
    { text: flag[0], at },
    { text: text.slice(flag[0].length), at: at + flag[0].length },
  ];
}

/** Where in `text` the first credential starts, or -1. */
function credentialOffset(text: string, lineStarts: ReadonlySet<number> = new Set()): number {
  const found = [...text.matchAll(WORD)].flatMap(splitAtFlagValue);
  const words = found.map(match => match.text);
  const curlAt = words.findIndex(word => bare(word).toLowerCase().endsWith('curl'));
  let hit = -1;
  for (let index = 0; index < words.length && hit === -1; index += 1) {
    hit = wordCredential(words, index, curlAt, found[index]?.at ?? 0, lineStarts);
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

const HEADER_NAME = 'authorization';

const AUTHORIZATION = /authorization/giu;

/** Where each word (a run with no space) ends, from every offset: `ends[i]` is the first space at or after `i`. */
function wordEnds(text: string): Int32Array {
  const ends = new Int32Array(text.length + 1);
  ends[text.length] = text.length;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    ends[index] = isSpace(text.charAt(index)) ? index : (ends[index + 1] ?? text.length);
  }
  return ends;
}

/** Where a word ending at `end` stops once its trailing value-end marks are trimmed: `kept[end]`, never before the word's start. */
function trimmedEnds(text: string): Int32Array {
  const kept = new Int32Array(text.length + 1);
  for (let index = 1; index <= text.length; index += 1) {
    kept[index] = VALUE_END.has(text.charAt(index - 1)) ? (kept[index - 1] ?? 0) : index;
  }
  return kept;
}

/**
 * Whether `part` gives an HTTP authorization header (or `--authorization=`) a value that is not a reference. The
 * scheme word (`Bearer`, `Basic`…) is skipped, and what follows it is judged like any value. One pass over the
 * text with offsets and no slicing of the tail, so a part made of nothing but `authorization:` stays linear.
 */
function givesAuthorization(part: string): boolean {
  const folded = foldedForScan(part);
  const ends = wordEnds(folded);
  const kept = trimmedEnds(folded);
  const size = folded.length;
  const skipSpaces = (from: number): number => {
    let at = from;
    while (at < size && isSpace(folded.charAt(at))) at += 1;
    return at;
  };
  const skipQuotes = (from: number): number => {
    let at = from;
    while (at < size && (VALUE_START.has(folded.charAt(at)) || folded.charAt(at) === '\\')) at += 1;
    return at;
  };
  for (const found of folded.matchAll(AUTHORIZATION)) {
    // A quoted name (`{"Authorization":"Basic …"}`, or the same escaped inside a string) closes its quote before the `:`.
    const separator = skipSpaces(skipQuotes(found.index + HEADER_NAME.length));
    if (folded.charAt(separator) !== ':' && folded.charAt(separator) !== '=') continue;
    let at = skipSpaces(separator + 1);
    let afterScheme = false;
    while (at < size) {
      const wordEnd = ends[at] ?? size;
      let from = at;
      while (from < wordEnd && (VALUE_START.has(folded.charAt(from)) || folded.charAt(from) === '\\')) from += 1;
      const to = Math.max(kept[wordEnd] ?? 0, from);
      at = skipSpaces(wordEnd);
      if (to === from) continue;
      if (!afterScheme && to - from <= LONGEST_SCHEME && SCHEMES.has(folded.slice(from, to).toLowerCase())) {
        afterScheme = true;
        continue;
      }
      if (!isReference(folded.slice(from, Math.min(to, from + REFERENCE_LENGTH + 1)))) return true;
      break;
    }
  }
  return false;
}

/** `--user=name:pass` or `-uname:pass`: the flag and its login in one piece, which `curlUser` (two words) does not see. */
function attachedCurlUser(piece: string): boolean {
  const folded = foldedForScan(piece);
  const login = folded.startsWith('--user=') ? folded.slice(7) : /^-u[^-]/u.test(folded) ? folded.slice(2) : '';
  const password = login.slice(login.indexOf(':') + 1);
  return login.includes(':') && password !== '' && !isReference(bare(password));
}

/** The most layers of encoding read through (a string inside a string, `\\"` inside `\"`): enough for a doubly escaped argument, bounded for a hostile one. */
const MAX_VIEW_LAYERS = 4;
/** The longest argument decoded: the contract holds far less, and a longer one is read as written, never parsed. */
const MAX_DECODED_CHARS = 8192;
const UNICODE_ESCAPE = /\\u([0-9A-Fa-f]{4})/gu;
const QUOTE_ESCAPE = /\\(["'\\])/gu;

/** The JSON a text IS, or that sits inside it (`--headers={…}`), written plainly again; undefined when there is none. Never throws. */
function plainJson(text: string): string | undefined {
  const tryParse = (candidate: string): unknown => {
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(text);
  if (typeof whole === 'string') return whole;
  if (whole !== null && typeof whole === 'object') return JSON.stringify(whole);
  const open = text.search(/[{[]/u);
  const close = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (open === -1 || close <= open) return undefined;
  const inner = tryParse(text.slice(open, close + 1));
  if (inner === null || typeof inner !== 'object') return undefined;
  const plain = JSON.stringify(inner);
  return plain === text.slice(open, close + 1) ? undefined : `${text.slice(0, open)} ${plain} ${text.slice(close + 1)}`;
}

/** One layer of encoding off `text`: JSON read as JSON, else `\uXXXX` made real and an escaped quote or backslash made plain, else percent-decoded. */
function oneLayerOff(text: string): string {
  const json = plainJson(text);
  if (json !== undefined) return json;
  const unescaped = text
    .replace(UNICODE_ESCAPE, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(QUOTE_ESCAPE, '$1');
  if (unescaped !== text) return unescaped;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Every form of an argument a program could read it as: as written, then with one layer of encoding off, up to
 * {@link MAX_VIEW_LAYERS} times (JSON decoded so `\uXXXX` names are real characters, escaped quotes made plain). The
 * scanners run on each, so a credential that only shows once the quoting is gone is still found. Bounded (a long
 * argument is read as written) and total (never throws).
 */
export function readableViews(piece: string): readonly string[] {
  const views = [piece];
  let current = piece;
  for (let layer = 0; layer < MAX_VIEW_LAYERS && current.length <= MAX_DECODED_CHARS; layer += 1) {
    const next = oneLayerOff(current);
    if (next === current) break;
    views.push(next);
    current = next;
  }
  return views;
}

/**
 * The 1-based place, among the pieces of a command line read as written, of the first one that holds a password or
 * key: any of the shapes above read across pieces (`curl`, `--user`, `name:pass` in three arguments), or an
 * `Authorization` header given any value. The pieces are read one to a line, so the place is never a guess.
 */
function firstCredentialIn(pieces: readonly string[]): number | undefined {
  const single = pieces.map(piece => foldedForScan(piece).replace(/\r\n|[\r\n]/gu, ' '));
  const curlAt = single.findIndex(piece => bare(piece).toLowerCase().endsWith('curl'));
  const header = single.findIndex(
    (piece, index) => givesAuthorization(piece) || (curlAt !== -1 && curlAt < index && attachedCurlUser(piece)),
  );
  const line = firstCredentialLine(single.join('\n'));
  if (header === -1) return line;
  return line === undefined ? header + 1 : Math.min(line, header + 1);
}

/**
 * The 1-based place, among the pieces of a command line, of the first one that holds a password or key, or undefined.
 * Every piece is read as written AND with its quoting taken off ({@link readableViews}), layer by layer, so a name
 * or a value hidden behind escaped quotes, a JSON string or `\uXXXX` escapes is found like a plain one; the
 * `${secret:NAME}` references stay exempt in every view.
 */
export function firstArgumentCredential(pieces: readonly string[]): number | undefined {
  const views = pieces.map(readableViews);
  const layers = Math.max(1, ...views.map(forms => forms.length));
  const places: number[] = [];
  for (let layer = 0; layer < layers; layer += 1) {
    const place = firstCredentialIn(views.map(forms => forms[layer] ?? forms.at(-1) ?? ''));
    if (place !== undefined) places.push(place);
  }
  return places.length === 0 ? undefined : Math.min(...places);
}
