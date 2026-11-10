/**
 * THE rule for what a command-line word may show: a launch flag and an MCP argument, wherever one travels — the
 * Resolved view (`POST /v1/runtimes/profiles/preview`) and a component's detail (`GET /v1/runtimes/components`) — so
 * a credential a person wrote into a flag is cut the same way on every read, for every caller, the edit form's owner
 * included.
 *
 * A credential sits in a word in four ways:
 * - a word that IS a token (`sk-…`), anywhere, also quoted;
 * - a value glued to a secret-named flag (`--token=v`, `-k=v`, `--token v` in one word, `-Hv`), or the word after one
 *   (`--token`, `v`). The name is the flag's (`looksSecret` reads `--api-key` as the words API and KEY, so dashes
 *   need no stripping); the value is unquoted first, so `--token="$TOKEN"` stays the pointer it is; and a token is
 *   looked for at the start of every piece of the value, so `--header=Bearer sk-…` is caught under a harmless name;
 * - a secret-named key NESTED inside a value (ruling #40): `-c mcp_servers.x.env.API_KEY=v`,
 *   `--header=Authorization: Bearer v`, `X-Api-Key: v`, and a URL's secret-named query parameter (`?token=v`); a
 *   quoted nested value runs to its closing quote (`API_KEY="v,w"`), and a key in a glued flag's own part counts too
 *   (`--hdr,api_key:v more`). A pointer in a value hides nothing else in it (review r2 M1): the keys after it are read
 *   (`API_KEY=${secret:X} CLIENT_SECRET=v`), and so is a piece of it set apart from the pointer
 *   (`Authorization: v LOG_LEVEL=${secret:X}`, `KEY=v ${secret:X}`), and so is every part of it before the pointer
 *   that a space or `#` sets apart, however many `=` or `:` it holds (review r3 N1: `Basic <b64>== X=${secret:X}`,
 *   `user:<v> ${secret:X}`), and so is what follows the pointer, base64 padding included (review r4 B2:
 *   `API_KEY=${secret:X} <b64>==`), and a secret-named FLAG's value is read the same way, a pointer on either side of
 *   it (review r4 B1: `--token <v> ${secret:X}`, `--token` then `${secret:X} <v>`);
 * - the password of a URL's user (`scheme://user:PASS@host`), up to the LAST `@` before the host.
 *
 * Only the VALUE is replaced: the flag's own spelling, a nested key's name, a URL's user and host and every other
 * parameter stay, because that is what tells a person which word it is. Every word today hid is still hidden: such a
 * word starts with a token prefix, so it is no flag and reaches the last test, whose `looksSecret` under any name
 * hides at least what it hides under none. And every word ruling #37 hid is still hidden as much: #37's three tests
 * run first, whole, and a nested cut only ever cuts more of a word they would show (`-H<token> KEY=v` stays
 * `-H‹hidden›`). Every way of reading a word with a value (the glued flag and its value, the value stuck to a
 * one-letter flag, the whole word) is searched and what ANY of them cuts is cut, so no reading shows what another hid.
 *
 * NOT handled (declared GAPs): a JSON document inside a flag (`--settings '{"env":{"API_KEY":"v"}}'`, its keys are
 * quoted), a plain password stuck to a one-letter flag (`-p<password>`: a single letter is no secret name), and a
 * value glued to a pointer with no space or `#` between them (`API_KEY=v${secret:X}`: it IS that pointer, as
 * `prefix${secret:X}` is). Also GAPs, each the same text as a harmless one (review r4): `user:pass` AFTER a pointer
 * (`API_KEY=${secret:X} person:<v>`, as `MODEL=gpt-4o-mini` is its own key, G5b); a quoted value of short words before
 * a pointer (`API_KEY="my pass phrase" ${secret:X}`, G6); and text under a harmless bare key before a pointer
 * (`Authorization: Basic X-Trace: <v> ${secret:X}`, G7: that key's own value).
 *
 * LINEAR in the word, however many keys share one value: where a value ends, whether it holds a pointer, and which of
 * its parts look like credentials, are read from tables built once per text ({@link valueEnds}).
 *
 * Pure.
 */
import { looksSecret, pointsElsewhere, secretNamed } from './credential-words.ts';
import { MIN_SECRET_VALUE_LENGTH, secretReferencePattern } from './secrets.ts';

/** What stands in a command-line word for the value that is not shown, and so can never be typed as one. */
export const HIDDEN_WORD_TEXT = '‹hidden›';

/** A word that is a flag on its own: one or two dashes and a name, with no value in it. */
const FLAG_WORD = /^-{1,2}[A-Za-z0-9][^=\s]*$/u;

/** A flag that is only a name: dashes, then letters, digits, `_`, `.` and `-`, with no separator in it. */
const PLAIN_FLAG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

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
  /**
   * The same as {@link piece}, but a key with no value of its own (`<b64>=` of `<b64>==`: its `=` is followed by a
   * `=`, a part break or the end) ends nothing: the piece after a pointer (review r4 B2).
   */
  readonly tail: Int32Array;
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
 * bare keys right to left again). `emptyKeys` are the keys of `keyStarts` that have no value of their own.
 */
function valueEnds(text: string, keyStarts: ReadonlyMap<number, number>, emptyKeys: ReadonlySet<number>): ValueEnds {
  const length = text.length;
  const value = new Int32Array(length + 1).fill(length);
  const piece = new Int32Array(length + 1).fill(length);
  const tail = new Int32Array(length + 1).fill(length);
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
      tail[at] = at;
    } else if (char === '"' || char === "'") {
      const match = char === '"' ? nextDouble : nextSingle;
      value[at] = match >= length ? length : (value[match + 1] as number);
      piece[at] = match >= length ? length : (piece[match + 1] as number);
      tail[at] = match >= length ? length : (tail[match + 1] as number);
      if (char === '"') nextDouble = at;
      else nextSingle = at;
    } else {
      value[at] = value[at + 1] as number;
      piece[at] = keyStarts.has(at) ? at : (piece[at + 1] as number);
      tail[at] = keyStarts.has(at) && !emptyKeys.has(at) ? at : (tail[at + 1] as number);
    }
  }
  for (let at = 0; at < length; at++)
    shownEnd[at + 1] = /\s/u.test(text[at] as string) ? (shownEnd[at] as number) : at + 1;
  const ends = {
    ...{ value, piece, tail, pointer, pointerStart, close, shownEnd },
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
 * Where the cut of a secret-named key's value `[start, end)` with a pointer in it must reach for the parts AFTER the
 * first pointer (review r4 B2): to the end of the text after it, up to the next key that has a value of its own
 * ({@link ValueEnds.tail}), when any part of it looks like a credential. It is the piece {@link heldInPiece} judges,
 * except that a key with no value (`<b64>=` of `<b64>==`) does not end it, so padding after a pointer is cut with the
 * rest. A text with no such key has the same piece as the one `heldInPiece` already judged. `start` when none does.
 */
function heldAfterPointer(text: string, ends: ValueEnds, name: string, start: number, end: number): number {
  const pointerEnd = ends.pointer[start] as number;
  if (pointerEnd > end) return start;
  const after = text.slice(pointerEnd, ends.tail[pointerEnd]).trimEnd();
  return heldParts(name, after) ? pointerEnd + after.length : start;
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
  return looksSecret(name, unquoted(piece.trim())) || heldParts(name, piece);
}

/** Whether any part of a text that a space or `#` sets apart looks like a credential, each judged on its own. */
const heldParts = (name: string, text: string): boolean =>
  text.split(PART_BREAK).some(part => looksSecret(name, unquoted(part)));

/** A quote mark: a closing one right after a padded `=` ends the value (`"Basic <b64>="`). */
const QUOTE_MARKS = new Set(['"', "'", '`']);

/**
 * Whether a key's separator is followed by nothing that is a value: a `=` after a `=`, a part break, a value end
 * (`,`, `;`, `&`) or the end of the text, or a quote mark that itself ends there. `<b64>==` reads as a key `<b64>=`
 * and a stray `=`, and `FOO= bar` as an empty `FOO` (review r4 B2); `FOO="bar baz"` is a value.
 */
function emptyValueKey(text: string, key: RegExpExecArray): boolean {
  const separator = key.index + key[0].search(/[:=]/u);
  const endsAt = (at: number): boolean => {
    const char = text[at];
    return char === undefined || PART_BREAK_CHAR.test(char) || NESTED_VALUE_END.has(char);
  };
  const next = text[separator + 1];
  return (
    text[separator] === '=' &&
    (endsAt(separator + 1) || next === '=' || (QUOTE_MARKS.has(next ?? '') && endsAt(separator + 2)))
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
  const emptyKeys = new Set(keys.filter(key => emptyValueKey(text, key)).map(key => key.index));
  const ends = valueEnds(text, new Map(keys.map(key => [key.index, key.index + key[0].search(/[:=]/u)])), emptyKeys);
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
    const to = Math.max(
      pieceEnd,
      heldBeforePointer(text, ends, start, end),
      heldAfterPointer(text, ends, name, start, end),
    );
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

export interface ShownWord {
  readonly text: string;
  readonly hidden: boolean;
}

/** The cuts of a part of a word that starts `offset` characters into it, as places in the word. */
const cutsAt = (offset: number, part: string): readonly Cut[] =>
  nestedCuts(part).map(([from, to]) => [from + offset, to + offset] as const);

/**
 * The cuts of a secret-named flag's value that starts `offset` characters into a word, when the value is no
 * credential as a whole because a pointer is in it (review r4 B1: `--token <v> ${secret:X}`, `--token` then
 * `Basic <v>#${secret:X}`): the flag is read as the key of its value, `flag=value`, so the rule a nested key's value
 * follows hides the flag's, whichever side of the pointer the credential is on. Nothing for a flag that names no
 * secret, so a harmless flag's value stays exactly as written; nor for a "flag" that holds a separator
 * (`-Hclient.secret:v`), which is a nested key of its own and is read as one.
 */
function flagValueCuts(flag: string, value: string, offset: number): readonly Cut[] {
  if (!PLAIN_FLAG.test(flag) || !secretNamed(flag)) return [];
  const head = `${flag}=`;
  return nestedCuts(`${head}${value}`).map(
    ([from, to]) => [from - head.length + offset, to - head.length + offset] as const,
  );
}

/** One command-line word as it may be shown, judged with the word before it. */
export function shownWord(word: string, before: string | undefined): ShownWord {
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
    ...(glued === null
      ? []
      : [
          ...cutsAt(0, gluedFlag),
          ...cutsAt(gluedFlag.length + separator.length, gluedValue),
          ...flagValueCuts(gluedFlag, gluedValue, gluedFlag.length + separator.length),
        ]),
    ...(name === '' ? [] : flagValueCuts(name, word, 0)),
    ...(stuck === null ? [] : cutsAt(stuckFlag.length, stuckValue)),
    ...((glued === null && stuck === null) || keyStartsBefore(word, gluedFlag.length) ? cutsAt(0, word) : []),
  ];
  return cuts.length === 0 ? { text: word, hidden: false } : hidden(withCuts(word, cuts));
}

/** A command line's words as they may be shown, in order; `first` is the word before the first (an MCP command). */
export const shownWords = (words: readonly string[], first?: string): readonly ShownWord[] =>
  words.map((word, index) => shownWord(word, index === 0 ? first : words[index - 1]));

/**
 * Whether a command line holds a credential ANYWHERE: the index of the first word the rule hides, or -1. `first` is the
 * word before the first (an MCP command). What Catalogs refuses on publish is exactly what Runtimes hides on read, so a
 * setup that reads clean on this machine reads clean on the installer's.
 */
export const firstHiddenWord = (words: readonly string[], first?: string): number =>
  shownWords(words, first).findIndex(word => word.hidden);

/**
 * Whether one environment entry holds a credential written out. The entry is read as the flag `--x-NAME=value`, the
 * glued reading a launch flag has (the `x-` only so a name that starts with `_` is still a flag's), so its name is judged
 * as a flag's name is, a token anywhere in the value is cut, and a secret-named key nested in the value counts
 * (`NAME=Authorization: Bearer v`). A whole `${secret:NAME}` pointer holds none.
 */
export const envEntryHidden = (name: string, value: string): boolean =>
  shownWord(`--x-${name}=${value}`, undefined).hidden;
