/**
 * The command-line rule as review round r3 left it, FROZEN from rebuild/fix-components-leak-r1 at 9a35f2d316
 * (`daemon/lib/service/command-line.ts`: `shownWord` and `shownWords`), so the differential holds the r4 rule to it as
 * a FOURTH floor: every word r3 hid must stay at least as hidden (review r3 N1 only ever cuts more). Only the imports
 * and the export names are changed, and the etag is left out: it shares the live `looksSecret`, `pointsElsewhere` and
 * `secretNamed`, byte-identical to r3's.
 *
 * Do not edit this to follow 5.0. It is a floor.
 */
import { MIN_SECRET_VALUE_LENGTH, secretReferencePattern } from '@ferretry/core-vault/contract';
import { HIDDEN_WORD_TEXT } from '../../../contract/index.ts';
import { looksSecret, pointsElsewhere, secretNamed } from '../../../daemon/lib/account/import.ts';

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

// ── Cuts ─────────────────────────────────────────────────────────────────────────────────────────

/** A cut: the characters `[from, to)` of a text, shown as one `‹hidden›`. */
type Cut = readonly [from: number, to: number];

/** Cuts in order, with the ones that overlap or touch made one. */
function merged(cuts: readonly Cut[]): readonly Cut[] {
  const out: [number, number][] = [];
  for (const [from, to] of [...cuts].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** A text with each cut shown as `‹hidden›`. */
function withCuts(text: string, cuts: readonly Cut[]): string {
  let out = '';
  let shown = 0;
  for (const [from, to] of merged(cuts)) {
    out += `${text.slice(shown, from)}${HIDDEN_WORD_TEXT}`;
    shown = to;
  }
  return `${out}${text.slice(shown)}`;
}

/** Every match of a global pattern in a text, read from its start. */
function matchesOf(pattern: RegExp, text: string): readonly RegExpExecArray[] {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)];
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

/** What sets a part of a value apart from a pointer next to it: a space, or a URL's fragment mark. */
const PART_BREAK = /[\s#]+/u;

/** For each index of a text, read once: where a nested value starting there ends, and what it holds. */
interface ValueEnds {
  /**
   * The next parameter separator that is not between a pair of quotes, or the text's end. A quote runs to its
   * matching one (`API_KEY="v,w"`, `KEY=a:'v,w'`), or to the text's end when it has none, so a `,` inside a quoted
   * value never ends it early (review r1 F3).
   */
  readonly value: Int32Array;
  /** The same, or the start of the next key not between a pair of quotes, if that comes first: a value's first piece. */
  readonly piece: Int32Array;
  /** The end of the first well-formed pointer (`${secret:NAME}`) that starts at or after it; past the end when none. */
  readonly pointer: Int32Array;
  /** The next `}`, or the text's end. */
  readonly close: Int32Array;
  /** Just past the last character before it that is not white space (0 when there is none). */
  readonly shownEnd: Int32Array;
}

/** {@link ValueEnds} of a text whose keys start at `keyStarts`, built right to left in one pass (shown ends left to right). */
function valueEnds(text: string, keyStarts: ReadonlySet<number>): ValueEnds {
  const length = text.length;
  const value = new Int32Array(length + 1).fill(length);
  const piece = new Int32Array(length + 1).fill(length);
  const pointer = new Int32Array(length + 1).fill(length + 1);
  const close = new Int32Array(length + 3).fill(length);
  const shownEnd = new Int32Array(length + 1);
  const pointerEnds = new Map(
    matchesOf(secretReferencePattern(), text).map(found => [found.index, found.index + found[0].length]),
  );
  let nextDouble = length;
  let nextSingle = length;
  for (let at = length - 1; at >= 0; at--) {
    const char = text[at] as string;
    pointer[at] = pointerEnds.get(at) ?? (pointer[at + 1] as number);
    close[at] = char === '}' ? at : (close[at + 1] as number);
    if (NESTED_VALUE_END.has(char)) {
      value[at] = at;
      piece[at] = at;
    } else if (char === '"' || char === "'") {
      const match = char === '"' ? nextDouble : nextSingle;
      value[at] = match >= length ? length : (value[match + 1] as number);
      piece[at] = match >= length ? length : (piece[match + 1] as number);
      if (char === '"') nextDouble = at;
      else nextSingle = at;
    } else {
      value[at] = value[at + 1] as number;
      piece[at] = keyStarts.has(at) ? at : (piece[at + 1] as number);
    }
  }
  for (let at = 0; at < length; at++)
    shownEnd[at + 1] = /\s/u.test(text[at] as string) ? (shownEnd[at] as number) : at + 1;
  return { value, piece, pointer, close, shownEnd };
}

/**
 * Whether a secret-named key's value `[start, end)` looks like a credential: `looksSecret` of it trimmed and unquoted,
 * as always. The answers a value many keys share would make slow are read from the tables first, and are the ones
 * `looksSecret` gives: a pointer in it, too short, or one `${…}` pointer and nothing else.
 */
function heldAt(text: string, ends: ValueEnds, name: string, start: number, end: number): boolean {
  if ((ends.pointer[start] as number) <= end || end - start < MIN_SECRET_VALUE_LENGTH) return false;
  if (text.startsWith('${', start) && ends.close[start + 2] === (ends.shownEnd[end] as number) - 1) return false;
  return looksSecret(name, unquoted(text.slice(start, end).trim()));
}

/**
 * Whether the first piece of a secret-named key's value, up to the next key or separator, holds a credential although
 * the value as a whole holds none, because a pointer is in it (review r2 M1): the piece itself
 * (`Authorization: v LOG_LEVEL=${secret:X}`), or a part of it that a space or `#` sets apart from a pointer
 * (`KEY=v ${secret:X}`, `?token=v#${secret:Y}`). A part with a pointer in it is that pointer (`Bearer ${secret:X}`,
 * `prefix${secret:X}`), and one too short to be a secret is none.
 */
function heldInPiece(name: string, piece: string): boolean {
  return (
    looksSecret(name, unquoted(piece.trim())) || piece.split(PART_BREAK).some(part => looksSecret(name, unquoted(part)))
  );
}

/**
 * The cuts of every secret-named key's value nested in a text, the key and the separator kept.
 *
 * Every key is read, in order. A value that looks like a credential is cut whole, and a key inside it is read only when
 * its own value runs on past the cut. One that does not (a pointer in it, too short) hides nothing else: the first
 * piece of it is judged on its own ({@link heldInPiece}), and the keys inside it are read on (review r2 M1:
 * `API_KEY=${secret:X} CLIENT_SECRET=v`, `password=${secret:X}?password:v`).
 */
function nestedValueCuts(text: string): readonly Cut[] {
  const keys = matchesOf(NESTED_NAME, text);
  if (keys.length === 0) return [];
  const ends = valueEnds(text, new Set(keys.map(key => key.index)));
  const cuts: Cut[] = [];
  let covered = 0;
  for (const key of keys) {
    const name = key[1] ?? '';
    if (!secretNamed(name)) continue;
    const start = key.index + key[0].length;
    const end = ends.value[start] as number;
    if (end <= covered) continue;
    if (heldAt(text, ends, name, start, end)) {
      cuts.push([start, end]);
      covered = end;
      continue;
    }
    const piece = text.slice(start, ends.piece[start]).trimEnd();
    if (!heldInPiece(name, piece)) continue;
    cuts.push([start, start + piece.length]);
    covered = Math.max(covered, start + piece.length);
  }
  return cuts;
}

/**
 * The password of a URL's user, `scheme://user:PASS@`: the part before it, and it. A scheme starts only where a run
 * of scheme characters starts; the user holds no `:` or `@`, and the password runs to the LAST `@` before the host's
 * path, query or fragment, as curl and a browser split it, so a raw `@` inside it (`u:p@ss@host`) is cut with it.
 */
const URL_PASSWORD = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@\s:]*:)([^/?#\s]*)@/gu;

/** The cut of each URL user's password in a text, unless it only points at one. */
const urlPasswordCuts = (text: string): readonly Cut[] =>
  matchesOf(URL_PASSWORD, text).flatMap(found => {
    const [, before = '', password = ''] = found;
    const from = found.index + before.length;
    return password === '' || pointsElsewhere(password) ? [] : [[from, from + password.length] as const];
  });

/**
 * Cuts made in a text whose URL passwords were cut first, as places in the text itself: the nested keys are read with
 * each password shown as `‹hidden›`, as they always were, and a cut that reaches into one reaches the whole password.
 * One walk: the cuts' places, merged, only ever move forward.
 */
function throughPasswords(cuts: readonly Cut[], passwords: readonly Cut[]): readonly Cut[] {
  let next = 0;
  let grown = 0;
  const place = (at: number, end: boolean): number => {
    for (; next < passwords.length; next++) {
      const [from, to] = passwords[next] as Cut;
      const shownFrom = from + grown;
      if (end ? at <= shownFrom : at < shownFrom) break;
      if (at < shownFrom + HIDDEN_WORD_TEXT.length) return end ? to : from;
      grown += HIDDEN_WORD_TEXT.length - (to - from);
    }
    return at - grown;
  };
  return merged(cuts).map(([from, to]) => [place(from, false), place(to, true)] as const);
}

/** The cuts of a value: each URL user's password, and each nested credential (inside one pair of quotes, kept). */
function nestedCuts(value: string): readonly Cut[] {
  const quoted = QUOTED.exec(value);
  const inner = quoted?.[2] ?? value;
  const offset = quoted === null ? 0 : 1;
  const passwords = urlPasswordCuts(inner);
  const nested =
    passwords.length === 0
      ? nestedValueCuts(inner)
      : throughPasswords(nestedValueCuts(withCuts(inner, passwords)), passwords);
  return [...passwords, ...nested].map(([from, to]) => [from + offset, to + offset] as const);
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

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

interface ShownWord {
  readonly text: string;
  readonly hidden: boolean;
}

/** The cuts of a part of a word that starts `offset` characters into it, as places in the word. */
const cutsAt = (offset: number, part: string): readonly Cut[] =>
  nestedCuts(part).map(([from, to]) => [from + offset, to + offset] as const);

/** One command-line word as it may be shown, judged with the word before it. */
function shownWord(word: string, before: string | undefined): ShownWord {
  const hidden = (text: string): ShownWord => ({ text, hidden: true });
  const glued = GLUED_VALUE.exec(word);
  const stuck = STUCK_VALUE.exec(word);
  const [, gluedFlag = '', separator = '', gluedValue = ''] = glued ?? [];
  const [, stuckFlag = '', stuckValue = ''] = stuck ?? [];
  // #37 first, whole: a value glued on or stuck to its flag, then the word under the flag before it. A nested cut
  // (#40) is only ever a FURTHER cut of a word #37 would show, so it never shows what #37 hid: `-H<token> KEY=v` is a
  // flag `-H<token>` with a value after a space, and stays `-H‹hidden›`.
  const stuckHidden = stuck !== null && secretValue('', stuckValue);
  if (glued !== null && secretValue(gluedFlag, gluedValue)) {
    // A token in what the glued reading calls the flag (`-H<token>,API_KEY=v`) is cut with everything after the letter,
    // as the stuck reading cuts it (review r2 G1).
    if (stuckHidden && secretValue('', gluedFlag.slice(stuckFlag.length)))
      return hidden(`${stuckFlag}${HIDDEN_WORD_TEXT}`);
    // A glued flag's own part may hold a nested key of its own (`--x&API_KEY:v;Bearer sk-…`), also one stuck to its
    // letter (`-cAPI_KEY:v,PASSWORD=w`, review r2 M2): it is cut too.
    const flagCuts = [
      ...cutsAt(0, gluedFlag),
      ...(stuck === null ? [] : cutsAt(stuckFlag.length, gluedFlag.slice(stuckFlag.length))),
    ];
    return hidden(`${withCuts(gluedFlag, flagCuts)}${separator}${HIDDEN_WORD_TEXT}`);
  }
  if (stuckHidden) return hidden(`${stuckFlag}${HIDDEN_WORD_TEXT}`);
  const name = before !== undefined && FLAG_WORD.test(before) && !word.startsWith('-') ? before : '';
  if (secretValue(name, word)) return hidden(HIDDEN_WORD_TEXT);
  // #40: every reading of the word is searched, and what any of them cuts is cut (review r2 M2, M3): a glued flag's own
  // part and its value; the value stuck to a one-letter flag, where a key the glued reading fuses with the letter is
  // seen (`-eAPI_KEY=v,token=w`); and the whole word, when it is no flag with a value, or when its flag part holds a
  // secret-named key whose value runs on past the glued separator (`--hdr,api_key=v;token=w`).
  const cuts = [
    ...(glued === null ? [] : [...cutsAt(0, gluedFlag), ...cutsAt(gluedFlag.length + separator.length, gluedValue)]),
    ...(stuck === null ? [] : cutsAt(stuckFlag.length, stuckValue)),
    ...((glued === null && stuck === null) || keyStartsBefore(word, gluedFlag.length) ? cutsAt(0, word) : []),
  ];
  return cuts.length === 0 ? { text: word, hidden: false } : hidden(withCuts(word, cuts));
}

/** r3's words of a command line, in order; `first` is the word before the first (an MCP command). */
export const shownWordsR3 = (words: readonly string[], first?: string): readonly ShownWord[] =>
  words.map((word, index) => shownWord(word, index === 0 ? first : words[index - 1]));
