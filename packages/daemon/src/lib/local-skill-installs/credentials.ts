/**
 * The narrow test that refuses a copy (docs/catalogs.md § Copying a skill from this machine). A skill file may
 * quote a password the person typed once: copied into another account or project it would become a credential
 * somewhere it was never meant to be, and the review must never draw it. Four shapes are certain enough to
 * refuse on — an address with a password in it (`scheme://user:pass@host`), a long value assigned to a name that
 * announces a secret (`API_KEY=…`, `api_key = "…"`, `token: …`, `"token": "…"`), an `Authorization: Bearer …`
 * header, and `curl -u user:pass`. Anything vaguer only WARNS (`mayHoldSecret`).
 *
 * The text is read the way "See changes" reads it (catalog-installs/conservative-changes.ts): invisible
 * characters out, look-alike forms folded (NFKC), the secret NAMES that file owns, and a second pass over the
 * lines joined so a name or a value a line break split is still found. It reports the LINE, never the value.
 * Pure and linear: plain scans, no backtracking pattern.
 */
import { foldedForScan, joinedLines, namesSecret } from '../catalog-installs/conservative-changes.ts';

const ASSIGNED_NAME = /^-{0,2}[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;
const MIN_VALUE_LENGTH = 16;
const ADDRESS_STOPS = new Set(['/', '?', '#', '"', "'", '<', '>', '`']);
const SCHEMES = new Set(['bearer', 'basic', 'token', 'digest']);
const LINE_END = /\r\n|[\r\n]/u;
const WORD = /\S+/gu;
const VALUE_ENDS = /^["'`]+|["'`,;})\]]+$/gu;
const NAME_ENDS = /^["'`{[(]+|["'`]+$/gu;

/** A value that points at a secret rather than holding one: `$VAR`, `${VAR}`, `<your key>`, `%VAR%`, `[…]`. */
const isReference = (value: string): boolean => /^[$<{[%]/u.test(value);

const isSpace = (character: string): boolean => character.trim() === '';

const bare = (word: string): string => word.replace(VALUE_ENDS, '');

const nameOf = (word: string): string => word.replace(NAME_ENDS, '');

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
function curlUser(words: readonly string[], index: number): boolean {
  const flag = bare(words[index] ?? '');
  if (flag !== '-u' && flag !== '--user') return false;
  if (!words.slice(0, index).some(word => bare(word).toLowerCase().endsWith('curl'))) return false;
  const login = bare(words[index + 1] ?? '');
  const password = login.slice(login.indexOf(':') + 1);
  return login.includes(':') && password !== '' && !isReference(password);
}

/** Where in `text` the first credential starts, or -1. */
function credentialOffset(text: string): number {
  const found = [...text.matchAll(WORD)];
  const words = found.map(match => match[0]);
  const hit = words.findIndex((_, index) => assignsSecret(words, index) || curlUser(words, index));
  const word = found[hit]?.index ?? -1;
  const address = addressWithPassword(text);
  return word === -1 || (address !== -1 && address < word) ? address : word;
}

/** The 1-based line that holds offset `at` of the lines joined with `glue` characters between them. */
function lineAt(lines: readonly string[], at: number, glue: number): number {
  let end = 0;
  return (
    lines.findIndex(line => {
      end += line.length + glue;
      return end > at;
    }) + 1
  );
}

/** The 1-based line of the first password or key in `text`, or undefined when there is none. */
export function firstCredentialLine(text: string): number | undefined {
  const folded = foldedForScan(text);
  const lines = folded.split(LINE_END);
  const own = lines.findIndex(line => credentialOffset(line) !== -1);
  if (own !== -1) return own + 1;
  // A value on the next line (YAML), then a name or value a line break split: the line the credential STARTS on.
  const joinings: readonly (readonly [string, number])[] = [
    [lines.join(' '), 1],
    [joinedLines(folded), 0],
  ];
  for (const [joined, glue] of joinings) {
    const at = credentialOffset(joined);
    if (at === -1) continue;
    return lineAt(lines, at, glue);
  }
  return undefined;
}
