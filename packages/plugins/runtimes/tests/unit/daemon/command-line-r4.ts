/**
 * The command-line rule as review round r4 left it, FROZEN from rebuild/fix-components-leak-r1 at 1d30b00ff4
 * (`core/vault/contract/command-line.ts`: `shownWord` and `shownWords`), so the differential holds the r5 rule to it as
 * a FIFTH floor: every word r4 hid must stay at least as hidden (review r4 B1 and B2 only ever cut more). Only the
 * imports and the export names are changed, and the etag is left out: it shares the live `looksSecret`,
 * `pointsElsewhere` and `secretNamed`, byte-identical to r4's.
 *
 * Do not edit this to follow 5.0. It is a floor.
 */
import {
  looksSecret,
  MIN_SECRET_VALUE_LENGTH,
  pointsElsewhere,
  secretNamed,
  secretReferencePattern,
} from '@ferretry/core-vault/contract';
import { HIDDEN_WORD_TEXT } from '../../../contract/index.ts';

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

/** One character that {@link PART_BREAK} splits at. */
const PART_BREAK_CHAR = /[\s#]/u;

/** One character a `$NAME` pointer's name may hold. */
const POINTER_NAME_CHAR = /[A-Za-z0-9_]/u;

/** The first character of a `$NAME` pointer's name. */
const POINTER_NAME_START = /[A-Za-z_]/u;

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
  /** The start of that pointer; the text's end when none. */
  readonly pointerStart: Int32Array;
  /** The next `}`, or the text's end. */
  readonly close: Int32Array;
  /** Just past the last character before it that is not white space (0 when there is none). */
  readonly shownEnd: Int32Array;
  /** The next character {@link PART_BREAK} splits at, or the text's end: where a part that holds it ends. */
  readonly partEnd: Int32Array;
  /** Where the part that holds it starts (for a character a part holds). */
  readonly partStart: Int32Array;
  /** The next character no `$NAME` pointer's name may hold, or the text's end. */
  readonly nameEnd: Int32Array;
  /** The start of the last part that ends at or before it and looks like a credential ({@link partHeld}); -1 when none. */
  readonly heldStart: Int32Array;
  /** That part's end; -1 when none. */
  readonly heldEnd: Int32Array;
  /** The start of the next part that is a key and its `:` and nothing else (`X-Trace:`), or the text's end. */
  readonly bareKey: Int32Array;
}

/**
 * {@link ValueEnds} of a text whose keys start at the keys of `keyStarts` (each with the place of its separator), built
 * right to left in one pass (shown ends, part starts and the parts that look like credentials left to right, and the
 * bare keys right to left again).
 */
function valueEnds(text: string, keyStarts: ReadonlyMap<number, number>): ValueEnds {
  const length = text.length;
  const value = new Int32Array(length + 1).fill(length);
  const piece = new Int32Array(length + 1).fill(length);
  const pointer = new Int32Array(length + 1).fill(length + 1);
  const pointerStart = new Int32Array(length + 1).fill(length);
  const close = new Int32Array(length + 3).fill(length);
  const shownEnd = new Int32Array(length + 1);
  const partEnd = new Int32Array(length + 1).fill(length);
  const partStart = new Int32Array(length + 1);
  const nameEnd = new Int32Array(length + 2).fill(length);
  const heldStart = new Int32Array(length + 1);
  const heldEnd = new Int32Array(length + 1);
  const bareKey = new Int32Array(length + 2).fill(length);
  const pointerEnds = new Map(
    matchesOf(secretReferencePattern(), text).map(found => [found.index, found.index + found[0].length]),
  );
  let nextDouble = length;
  let nextSingle = length;
  for (let at = length - 1; at >= 0; at--) {
    const char = text[at] as string;
    const pointerEnd = pointerEnds.get(at);
    pointer[at] = pointerEnd ?? (pointer[at + 1] as number);
    pointerStart[at] = pointerEnd === undefined ? (pointerStart[at + 1] as number) : at;
    close[at] = char === '}' ? at : (close[at + 1] as number);
    partEnd[at] = PART_BREAK_CHAR.test(char) ? at : (partEnd[at + 1] as number);
    nameEnd[at] = POINTER_NAME_CHAR.test(char) ? (nameEnd[at + 1] as number) : at;
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
  const ends = {
    ...{ value, piece, pointer, pointerStart, close, shownEnd },
    ...{ partEnd, partStart, nameEnd, heldStart, heldEnd, bareKey },
  };
  let held: Cut | undefined;
  for (let at = 0; at <= length; at++) {
    const breaks = at === length || PART_BREAK_CHAR.test(text[at] as string);
    if (!breaks) partStart[at] = at > 0 && partEnd[at - 1] !== at - 1 ? (partStart[at - 1] as number) : at;
    else if (at > 0 && partEnd[at - 1] === at) {
      const from = partStart[at - 1] as number;
      if (text[at - 1] === ':' && keyStarts.get(from) === at - 1) bareKey[from] = from;
      else if (partHeld(text, ends, from, at)) held = [from, at];
    }
    heldStart[at] = held?.[0] ?? -1;
    heldEnd[at] = held?.[1] ?? -1;
  }
  for (let at = length - 1; at >= 0; at--) bareKey[at] = Math.min(bareKey[at] as number, bareKey[at + 1] as number);
  return ends;
}

/**
 * Whether the part `[from, to)` of a secret-named key's value, before the first `${secret:…}` pointer in it, looks
 * like a credential, read from the tables: exactly `looksSecret` of it unquoted, which under a secret name is long
 * enough and no pointer (not one `$NAME` or `${…}`; it holds no `${secret:…}`, as it stands before the first).
 */
function partHeld(text: string, ends: ValueEnds, from: number, to: number): boolean {
  const quote = text[from];
  const quoted = to - from >= 2 && (quote === '"' || quote === "'") && text[to - 1] === quote;
  const start = quoted ? from + 1 : from;
  const end = quoted ? to - 1 : to;
  if (end - start < MIN_SECRET_VALUE_LENGTH) return false;
  if (text[start] !== '$') return true;
  if (text[start + 1] === '{') return ends.close[start + 2] !== end - 1;
  return !(POINTER_NAME_START.test(text[start + 1] as string) && (ends.nameEnd[start + 1] as number) >= end);
}

/**
 * Where the cut of a secret-named key's value `[start, end)` with a pointer in it must reach for the parts before the
 * pointer (review r3 N1): to the end of the last of them that looks like a credential, each judged on its own
 * ({@link partHeld}), however many `=` or `:` it holds (`Basic <b64>==`, `user:<v>`), because the key a `<b64>=`
 * or a `user:` reads as ends no piece of a credential. The part that holds the pointer is that pointer, and is not
 * judged; nor is a part from a key that stands alone with its `:` (`X-Trace: ${secret:X}`) on, as such a key's
 * value is set apart from it. `start` when none looks like a credential, or there is no pointer: then the whole
 * value was judged.
 */
function heldBeforePointer(text: string, ends: ValueEnds, start: number, end: number): number {
  if ((ends.pointer[start] as number) > end) return start;
  const pointerPart = ends.partStart[ends.pointerStart[start] as number] as number;
  const limit = Math.max(start, Math.min(pointerPart, ends.bareKey[start] as number));
  if (limit === start) return start;
  const first = ends.partEnd[start] as number;
  const last = (ends.heldStart[limit] as number) >= first ? (ends.heldEnd[limit] as number) : start;
  return Math.max(last, partHeld(text, ends, start, first) ? first : start);
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
 * piece of it is judged on its own ({@link heldInPiece}), and so is each part before its pointer
 * ({@link heldBeforePointer}, review r3 N1), and the keys inside it are read on (review r2 M1:
 * `API_KEY=${secret:X} CLIENT_SECRET=v`, `password=${secret:X}?password:v`).
 */
function nestedValueCuts(text: string): readonly Cut[] {
  const keys = matchesOf(NESTED_NAME, text);
  if (keys.length === 0) return [];
  const ends = valueEnds(text, new Map(keys.map(key => [key.index, key.index + key[0].search(/[:=]/u)])));
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
    const pieceEnd = heldInPiece(name, piece) ? start + piece.length : start;
    const to = Math.max(pieceEnd, heldBeforePointer(text, ends, start, end));
    if (to === start) continue;
    cuts.push([start, to]);
    covered = Math.max(covered, to);
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

/** r4's words of a command line, in order; `first` is the word before the first (an MCP command). */
export const shownWordsR4 = (words: readonly string[], first?: string): readonly ShownWord[] =>
  words.map((word, index) => shownWord(word, index === 0 ? first : words[index - 1]));
