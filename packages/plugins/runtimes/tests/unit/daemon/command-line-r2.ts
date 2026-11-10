/**
 * The command-line rule as review round r2 left it, FROZEN from rebuild/fix-components-leak-r1 at 3611727ee2
 * (`core/vault/contract/command-line.ts`: `shownWord` and `shownWords`), so the differential holds the r3 rule to it as
 * a THIRD floor: every word r2 hid must stay at least as hidden (review r2 M1–M3 only ever cut more). Only the imports
 * and the export names are changed, and the etag is left out: it shares the live `looksSecret`, `pointsElsewhere` and
 * `secretNamed`, byte-identical to r2's.
 *
 * Do not edit this to follow 5.0. It is a floor.
 */
import { HIDDEN_WORD_TEXT } from '../../../contract/index.ts';
import { looksSecret, pointsElsewhere, secretNamed } from '@ferretry/core-vault/contract';
/** A word that is a flag on its own: one or two dashes and a name, with no value in it. */
const FLAG_WORD = /^-{1,2}[A-Za-z0-9][^=\s]*$/u;

/** A flag and its value in one word, glued by `=` or by spaces: `--token=v`, `-k=v`, `--token v`. */
const GLUED_VALUE = /^(-{1,2}[A-Za-z0-9][^=\s]*)(=|\s+)([\s\S]*)$/u;

/** A one-letter flag with its value stuck straight to it: `-Hv`. */
const STUCK_VALUE = /^(-[A-Za-z])([^-=\s][\s\S]*)$/u;

/** What splits a value into the pieces a token may start at: spaces, quotes and separators. */
const PIECE_BREAK = /[\s"'`:,;=]+/u;

/** A value inside one pair of matching quotes: the quote and what it holds. */
const QUOTED = /^(["'])([\s\S]*)\1$/u;

/** A value without one pair of matching quotes around it. */
const unquoted = (value: string): string => QUOTED.exec(value)?.[2] ?? value;

/** Whether a flag's value looks like a credential under the flag's name, or holds a token. */
function secretValue(name: string, value: string): boolean {
  return looksSecret(name, unquoted(value)) || value.split(PIECE_BREAK).some(piece => looksSecret('', piece));
}

// ── Nested inside a value (ruling #40) ───────────────────────────────────────────────────────────

/**
 * A name and its separator inside a value: `API_KEY=`, `Authorization: `, `X-Api-Key:`, `?token=`.
 *
 * LINEAR: a name starts only where a run of name characters starts (the look-behind), after any leading digits, dots
 * and dashes, so a long run with no separator after it is scanned once, not once from every character in it. A name
 * right after `${` is a pointer's (`${secret:NAME}`, `${NAME:-x}`), never a key.
 */
const NESTED_NAME = /(?<![A-Za-z0-9_.-]|\$\{)[0-9.-]*([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*[:=][ \t]*/gu;

/** What ends a nested value: a parameter separator (`a=1,b=2`, `?a=1&b=2`, `a=1; b=2`). */
const NESTED_VALUE_END = new Set([',', ';', '&']);

/**
 * The index just past a nested value starting at `start`: the next parameter separator that is not between a pair of
 * quotes, or the text's end. A quote runs to its matching one (`API_KEY="v,w"`, `KEY=a:'v,w'`), or to the text's end
 * when it has none, so a `,` inside a quoted value never ends it early (review r1 F3).
 */
function nestedValueEnd(text: string, start: number): number {
  for (let at = start; at < text.length; at++) {
    const char = text[at] as string;
    if (NESTED_VALUE_END.has(char)) return at;
    if (char === '"' || char === "'") {
      const close = text.indexOf(char, at + 1);
      if (close < 0) return text.length;
      at = close;
    }
  }
  return text.length;
}

/**
 * The password of a URL's user, `scheme://user:PASS@`: the part before it, and it. A scheme starts only where a run
 * of scheme characters starts; the user holds no `:` or `@`, and the password runs to the LAST `@` before the host's
 * path, query or fragment, as curl and a browser split it, so a raw `@` inside it (`u:p@ss@host`) is cut with it.
 */
const URL_PASSWORD = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@\s:]*:)([^/?#\s]*)@/gu;

/** A text with each URL user's password cut, unless it only points at one. */
const withoutUrlPasswords = (text: string): string =>
  text.replace(URL_PASSWORD, (whole, before: string, password: string) =>
    password === '' || pointsElsewhere(password) ? whole : `${before}${HIDDEN_WORD_TEXT}@`,
  );

/** A text with the value of every secret-named key nested in it cut, the key and the separator kept. */
function withoutNestedValues(text: string): string {
  let out = '';
  let from = 0;
  NESTED_NAME.lastIndex = 0;
  for (let found = NESTED_NAME.exec(text); found !== null; found = NESTED_NAME.exec(text)) {
    const name = found[1] ?? '';
    if (!secretNamed(name)) continue;
    const start = found.index + found[0].length;
    const end = nestedValueEnd(text, start);
    // A secret-named key whose value is no secret (a pointer, too short) is passed over whole, so a run of keys is
    // read once.
    NESTED_NAME.lastIndex = Math.max(end, start + 1);
    if (!looksSecret(name, unquoted(text.slice(start, end).trim()))) continue;
    out += `${text.slice(from, start)}${HIDDEN_WORD_TEXT}`;
    from = end;
  }
  return `${out}${text.slice(from)}`;
}

/**
 * Whether a word holds a secret-named key, with its separator, that starts before `limit`: in a glued flag's own part
 * (`--hdr,api_key:v more`), or as its last name, whose separator is the glued one (`--x&X-Api-Key=v,${secret:Y}`).
 */
function keyStartsBefore(word: string, limit: number): boolean {
  NESTED_NAME.lastIndex = 0;
  for (let found = NESTED_NAME.exec(word); found !== null && found.index < limit; found = NESTED_NAME.exec(word)) {
    if (secretNamed(found[1] ?? '')) return true;
  }
  return false;
}

/** A value with every nested credential cut (inside one pair of quotes, kept), or `undefined` when it holds none. */
function withoutNested(value: string): string | undefined {
  const quoted = QUOTED.exec(value);
  const inner = quoted?.[2] ?? value;
  const cut = withoutNestedValues(withoutUrlPasswords(inner));
  if (cut === inner) return undefined;
  return quoted === null ? cut : `${quoted[1] ?? ''}${cut}${quoted[1] ?? ''}`;
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

interface ShownWord {
  readonly text: string;
  readonly hidden: boolean;
}

/** One command-line word as it may be shown, judged with the word before it. */
function shownWord(word: string, before: string | undefined): ShownWord {
  const hidden = (text: string): ShownWord => ({ text, hidden: true });
  const glued = GLUED_VALUE.exec(word);
  const stuck = STUCK_VALUE.exec(word);
  // #37 first, whole: a value glued on or stuck to its flag, then the word under the flag before it. A nested cut
  // (#40) is only ever a FURTHER cut of a word #37 would show, so it never shows what #37 hid: `-H<token> KEY=v` is a
  // flag `-H<token>` with a value after a space, and stays `-H‹hidden›`.
  const [, gluedFlag = '', separator = '', gluedValue = ''] = glued ?? [];
  // A glued flag's own part may hold a nested key of its own (`--x&API_KEY:v;Bearer sk-…`): whatever cuts the value
  // cuts that too.
  const flagPart = (): string => withoutNested(gluedFlag) ?? gluedFlag;
  if (glued !== null && secretValue(gluedFlag, gluedValue))
    return hidden(`${flagPart()}${separator}${HIDDEN_WORD_TEXT}`);
  const [, stuckFlag = '', stuckValue = ''] = stuck ?? [];
  if (stuck !== null && secretValue('', stuckValue)) return hidden(`${stuckFlag}${HIDDEN_WORD_TEXT}`);
  const name = before !== undefined && FLAG_WORD.test(before) && !word.startsWith('-') ? before : '';
  if (secretValue(name, word)) return hidden(HIDDEN_WORD_TEXT);
  // #40: a flag's own value is searched (glued, else stuck); a word that is no flag with a value is searched whole, and
  // so is one whose flag part itself holds a secret-named key (`--hdr,api_key:v more`, `--x&Api-Key=v,${secret:Y}`).
  const gluedCut = glued === null ? undefined : withoutNested(gluedValue);
  if (gluedCut !== undefined) return hidden(`${flagPart()}${separator}${gluedCut}`);
  const stuckCut = stuck === null ? undefined : withoutNested(stuckValue);
  if (stuckCut !== undefined) return hidden(`${stuckFlag}${stuckCut}`);
  const whole = (glued === null && stuck === null) || keyStartsBefore(word, gluedFlag.length);
  const cut = whole ? withoutNested(word) : undefined;
  return cut === undefined ? { text: word, hidden: false } : hidden(cut);
}

/** r2's words of a command line, in order; `first` is the word before the first (an MCP command). */
export const shownWordsR2 = (words: readonly string[], first?: string): readonly ShownWord[] =>
  words.map((word, index) => shownWord(word, index === 0 ? first : words[index - 1]));
