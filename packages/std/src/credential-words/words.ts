/**
 * THE rule for what a command-line word may show (cfg-leak, CFG-LEAK-R), declared once: a configuration file's text is
 * read by every `fleet.use` caller and every ferret, so a credential a person wrote into a flag, an MCP argument or a
 * nested value is cut the same way on every read, for every caller, the edit form's owner included. The kernel's read
 * mask (`shownConfigText`) and Runtimes' views (Resolved view, component detail, runtime list) both import it, and each
 * runs the write rule W (`./write-rule.ts`) on what this cuts and withholds what W still refuses (the net), so a word W
 * refuses is a word no consumer shows by construction.
 *
 * It holds the fleet's word tests too (`looksSecret`, `secretNamed`, `pointsElsewhere`, the token formats), which the
 * fleet import rules also use: {@link looksSecret} is the fleet's, {@link looksSecretShown} widens its NAME test to
 * {@link namesCredential} for a word that is only being SHOWN. Below, "the Resolved view" and "a component's detail" are
 * Runtimes' two readers of the same rule.
 *
 * The rule: a launch flag and an MCP argument, wherever one travels.
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
 * quoted) and a plain password stuck to a one-letter flag (`-p<password>`: a single letter is no secret name). A value
 * glued to a pointer with no space or `#` between them (`API_KEY=v${secret:X}`, `prefix${secret:X}`,
 * `${secret:X}?model=short`) is NOT one: CFG-LEAK-R cuts the whole value ({@link gluedToPointer}), because the write
 * rule refuses it. The same holds for raw text in ANY piece of a credential's value that holds a pointer
 * (`prefix${secret:X},<v>`, `a,<v>,${secret:X}`, `${secret:X},b=<v>`): where the write rule refuses that value whole,
 * it is cut whole, value start to word end ({@link refusedCuts}), over-cutting the pointer in it. That is the closed
 * corpus (residual 0 over it), not every value W refuses: the families F1-F7 (a look-alike of a pointer, a blank and a
 * token shape, a pointer in a URL's user part, a value starting `.`, a pointer never closed, past W's 4096-character
 * window, one item holding blanks) are refused by W and not cut here; they are held by the NET in each consumer
 * (`shownConfigText` withholds the file, Runtimes' views withhold the item; `kernel-cutter-f1-f7-pin.test.ts`). The one
 * limit of the net: a refused line whose masked text W accepts bare (a 16-character value of entropy under 3.5), 57 lines
 * of the review corpus, pinned in `net-low-entropy-pin.test.ts`. A name is a credential's by the tail test ({@link namesCredential}) or by the older words below.
 * Also GAPs, each the same text as a harmless one (review r4): `user:pass` AFTER a pointer
 * (`API_KEY=${secret:X} person:<v>`, as `MODEL=gpt-4o-mini` is its own key, G5b); a quoted value of short words before
 * a pointer (`API_KEY="my pass phrase" ${secret:X}`, G6); and text under a harmless bare key before a pointer
 * (`Authorization: Basic X-Trace: <v> ${secret:X}`, G7: that key's own value).
 *
 * LINEAR in the word, however many keys share one value: where a value ends, whether it holds a pointer, and which of
 * its parts look like credentials, are read from tables built once per text ({@link valueEnds}).
 *
 * Pure.
 */
import {
  HIDDEN_VALUE_TEXT,
  holdsSecretReference,
  MIN_SECRET_VALUE_LENGTH,
  secretReferencePattern,
} from '../secret-reference.ts';

export { HIDDEN_VALUE_TEXT };

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
  return looksSecretShown(name, unquoted(value)) || value.split(PIECE_BREAK).some(piece => looksSecretShown('', piece));
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
    out += `${text.slice(shown, from)}${HIDDEN_VALUE_TEXT}`;
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
  /**
   * The next parameter separator, not between quotes, that is followed by text no key of its own starts and that is
   * more than the separator in its part: where raw text is glued after keys (`,b=2,<v>`); the text's end when none.
   */
  readonly loose: Int32Array;
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
  const loose = new Int32Array(length + 1).fill(length);
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
      loose[at] =
        at + 1 < (partEnd[at] as number) && (tail[at + 1] as number) > at + 1 ? at : (loose[at + 1] as number);
    } else if (char === '"' || char === "'") {
      const match = char === '"' ? nextDouble : nextSingle;
      value[at] = match >= length ? length : (value[match + 1] as number);
      piece[at] = match >= length ? length : (piece[match + 1] as number);
      tail[at] = match >= length ? length : (tail[match + 1] as number);
      loose[at] = match >= length ? length : (loose[match + 1] as number);
      if (char === '"') nextDouble = at;
      else nextSingle = at;
    } else {
      value[at] = value[at + 1] as number;
      piece[at] = keyStarts.has(at) ? at : (piece[at + 1] as number);
      tail[at] = keyStarts.has(at) && !emptyKeys.has(at) ? at : (tail[at + 1] as number);
      loose[at] = loose[at + 1] as number;
    }
  }
  for (let at = 0; at < length; at++)
    shownEnd[at + 1] = /\s/u.test(text[at] as string) ? (shownEnd[at] as number) : at + 1;
  const ends = {
    ...{ value, piece, tail, pointer, pointerStart, close, shownEnd },
    ...{ partEnd, partStart, nameEnd, heldStart, heldEnd, bareKey, loose },
  };
  let held: Cut | undefined;
  for (let at = 0; at <= length; at++) {
    const breaks = at === length || PART_BREAK_CHAR.test(text[at] as string);
    if (!breaks) partStart[at] = at > 0 && partEnd[at - 1] !== at - 1 ? (partStart[at - 1] as number) : at;
    else if (at > 0 && partEnd[at - 1] === at) {
      const from = partStart[at - 1] as number;
      if (text[at - 1] === ':' && keyStarts.get(from) === at - 1) bareKey[from] = from;
      else if (partHeldAny(text, ends, from, at)) held = [from, at];
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
 * Where the cut of a secret-named key's value `[start, end)` must reach when the part that holds its first
 * `${secret:…}` pointer glues text to it (CFG-LEAK-R, `API_KEY=prefix${secret:X}`, `Authorization: Bearer v${secret:X}`,
 * `API_KEY=${secret:X}?model=short`): to the end of that part, the whole value from its start (over-hiding the words
 * before the part is accepted). A part that is exactly ONE pointer (`${secret:X}`, `"${secret:X}"`) stays shown, and
 * so does one that is a key's own value (`X=${secret:X}`); two pointers run together are glued as text is. `start` when
 * there is no pointer or it stands alone. Reads two characters beside the pointer, so it never costs more than that.
 */
function gluedToPointer(text: string, ends: ValueEnds, start: number, end: number): number {
  if ((ends.pointer[start] as number) > end) return start;
  const at = ends.pointerStart[start] as number;
  const partFrom = Math.max(start, ends.partStart[at] as number);
  const valueTo = Math.min(end, ends.partEnd[at] as number);
  // Text before the pointer is no glue when it is a key's own separator (`X=${secret:X}`, `a:${secret:X}`) or a quote.
  const before = at > partFrom ? (text[at - 1] as string) : '=';
  if (!GLUE_FREE_BEFORE.has(before)) return valueTo;
  const next = ends.pointer[at] as number;
  // A `,` `;` `&` right after the pointer ends the key's value, but the text after it is glued to the pointer unless a
  // key of its own starts there (`${secret:X},v` and `${secret:X},b=2,v` are cut to the end of its part, `${secret:X},b=2`
  // is not).
  const runsOn = next === end && (ends.loose[next] as number) < (ends.partEnd[at] as number);
  const partTo = runsOn ? (ends.partEnd[at] as number) : valueTo;
  const after = next < partTo ? (text[next] as string) : '';
  return after === '' || (next === partTo - 1 && QUOTE_MARKS.has(after) && QUOTE_MARKS.has(before)) ? start : partTo;
}

/** What may stand right before a pointer without being glued to it: a key's separator or a quote mark. */
const GLUE_FREE_BEFORE = new Set(['=', ':', '"', "'", '`']);

/**
 * Where the cut of a secret-named key's value `[start, end)` with a pointer in it must reach for the parts AFTER the
 * first pointer (review r4 B2): to the end of the text after it, up to the next key that has a value of its own
 * ({@link ValueEnds.tail}), when any part of it looks like a credential. It is the piece {@link heldInPiece} judges,
 * except that a key with no value (`<b64>=` of `<b64>==`) does not end it, so padding after a pointer is cut with the
 * rest. A text with no such key has the same piece as the one `heldInPiece` already judged. `start` when none does.
 *
 * Read from the tables, not from a copy of the text (a hostile text of empty keys and pointers would make every key
 * copy the rest of it): the caller has judged the key's NAME secret, so a part looks like a credential when it is long
 * enough and no pointer ({@link partHeldAny}), whatever the name is.
 */
function heldAfterPointer(text: string, ends: ValueEnds, start: number, end: number): number {
  const pointerEnd = ends.pointer[start] as number;
  if (pointerEnd > end) return start;
  // Just past the last character that is not white space, where the text after the pointer ends.
  const stop = Math.max(pointerEnd, ends.shownEnd[ends.tail[pointerEnd] as number] as number);
  return heldAnyPart(text, ends, pointerEnd, stop) ? stop : start;
}

/**
 * Whether any part of `[from, stop)`, split at what {@link PART_BREAK} splits at, looks like a credential: the first part
 * (cut at `from`) and the last (cut at `stop`) on their own, and every whole part between them from
 * {@link ValueEnds.heldStart}, the last one that holds.
 */
function heldAnyPart(text: string, ends: ValueEnds, from: number, stop: number): boolean {
  if (from >= stop) return false;
  const firstEnd = Math.min(ends.partEnd[from] as number, stop);
  if (partHeldAny(text, ends, from, firstEnd)) return true;
  if (firstEnd >= stop) return false;
  const clipped = (ends.partEnd[stop - 1] as number) > stop;
  const lastStart = clipped ? (ends.partStart[stop - 1] as number) : stop;
  if (clipped && lastStart > firstEnd && partHeldAny(text, ends, lastStart, stop)) return true;
  return (ends.heldStart[clipped ? lastStart - 1 : stop] as number) > firstEnd;
}

/** {@link partHeld} of a part that holds no pointer: a part with one is that pointer's and is no credential. */
const partHeldAny = (text: string, ends: ValueEnds, from: number, to: number): boolean =>
  (ends.pointer[from] as number) > to && partHeld(text, ends, from, to);

/**
 * Whether a secret-named key's value `[start, end)` looks like a credential: `looksSecret` of it trimmed and unquoted,
 * as always. The answers a value many keys share would make slow are read from the tables first, and are the ones
 * `looksSecret` gives: a pointer in it, too short, or one `${…}` pointer and nothing else.
 */
function heldAt(text: string, ends: ValueEnds, name: string, start: number, end: number): boolean {
  if ((ends.pointer[start] as number) <= end || end - start < MIN_SECRET_VALUE_LENGTH) return false;
  if (text.startsWith('${', start) && ends.close[start + 2] === (ends.shownEnd[end] as number) - 1) return false;
  return looksSecretShown(name, unquoted(text.slice(start, end).trim()));
}

/**
 * Whether the first piece of a secret-named key's value, up to the next key or separator, holds a credential although
 * the value as a whole holds none, because a pointer is in it (review r2 M1): the piece itself
 * (`Authorization: v LOG_LEVEL=${secret:X}`), or a part of it that a space or `#` sets apart from a pointer
 * (`KEY=v ${secret:X}`, `?token=v#${secret:Y}`). A part with a pointer in it is that pointer (`Bearer ${secret:X}`,
 * `prefix${secret:X}`), and one too short to be a secret is none.
 */
function heldInPiece(name: string, piece: string): boolean {
  return looksSecretShown(name, unquoted(piece.trim())) || heldParts(name, piece);
}

/** Whether any part of a text that a space or `#` sets apart looks like a credential, each judged on its own. */
const heldParts = (name: string, text: string): boolean =>
  text.split(PART_BREAK).some(part => looksSecretShown(name, unquoted(part)));

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
    if (!secretNamedShown(name)) continue;
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
      heldAfterPointer(text, ends, start, end),
      gluedToPointer(text, ends, start, end),
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
export const urlPasswordCuts = (text: string): readonly Cut[] =>
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
      if (at < shownFrom + HIDDEN_VALUE_TEXT.length) return end ? to : from;
      grown += HIDDEN_VALUE_TEXT.length - (to - from);
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
    if (secretNamedShown(found[1] ?? '')) return true;
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
  if (!PLAIN_FLAG.test(flag) || !secretNamedShown(flag)) return [];
  const head = `${flag}=`;
  return nestedCuts(`${head}${value}`).map(
    ([from, to]) => [from - head.length + offset, to - head.length + offset] as const,
  );
}

/**
 * The write rule's value test past its name gate (`write-rule.ts` `looksLikeRawSecret`): what it refuses whole.
 * A copy of the test, not the whole rule: the F1-F7 families W refuses and this cutter still shows are held by each
 * consumer's net (`kernel-cutter-f1-f7-pin.test.ts`), so the cutter alone cuts what W refuses over the closed corpus
 * only.
 */
const WHOLE_SCHEME = /^(?:bearer|basic|token)[ \t]+/iu;
const WHOLE_REFERENCE = /^\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)$/u;
const WHOLE_PLACE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[/~.])/iu;
const WHOLE_PAIR = /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*[:=][ \t]*/u;
const WHOLE_HEADER = /^(?:authorization|cookie)$/iu;
function refusedWhole(value: string): boolean {
  if (!value.includes('${secret:')) return false;
  const inner = unquoted(value).trim().replace(WHOLE_SCHEME, '');
  if (inner.length < 16 || /\s/u.test(inner) || WHOLE_REFERENCE.test(inner) || WHOLE_PLACE.test(inner)) return false;
  const counts = new Map<string, number>();
  for (const char of inner) counts.set(char, (counts.get(char) ?? 0) + 1);
  const length = [...inner].length;
  return [...counts.values()].reduce((bits, count) => bits - (count / length) * Math.log2(count / length), 0) >= 3.5;
}

/**
 * The cuts of what the write rule judges WHOLE in a word, where a pointer in it kept the rules above from cutting it
 * (review r3: `--key ${secret:X},b=2,v`, `KEY=a,v,${secret:X}`): a credential-named flag's value (glued, or the word
 * after it), and the value of a credential-named key that starts the word or the glued value. Value start to word end.
 */
function refusedCuts(word: string, flag: string, valueAt: number): readonly Cut[] {
  const cuts: Cut[] = [];
  if (flag !== '' && namesCredential(flag) && refusedWhole(word.slice(valueAt))) cuts.push([valueAt, word.length]);
  for (const at of new Set([0, valueAt])) {
    const pair = WHOLE_PAIR.exec(word.slice(at));
    const name = pair?.[1] ?? '';
    if (
      pair !== null &&
      (namesCredential(name) || WHOLE_HEADER.test(name)) &&
      refusedWhole(word.slice(at + pair[0].length))
    )
      cuts.push([at + pair[0].length, word.length]);
  }
  return cuts;
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
      return hidden(`${stuckFlag}${HIDDEN_VALUE_TEXT}`);
    // A token in the flag's own part (`--x;ghp_…,tokens v`) is cut with the word, not shown beside the cut value.
    if (secretValue('', gluedFlag)) return hidden(HIDDEN_VALUE_TEXT);
    // A glued flag's own part may hold a nested key of its own (`--x&API_KEY:v;Bearer sk-…`), also one stuck to its
    // letter (`-cAPI_KEY:v,PASSWORD=w`, review r2 M2): it is cut too.
    const flagCuts = [
      ...cutsAt(0, gluedFlag),
      ...(stuck === null ? [] : cutsAt(stuckFlag.length, gluedFlag.slice(stuckFlag.length))),
    ];
    return hidden(`${withCuts(gluedFlag, flagCuts)}${separator}${HIDDEN_VALUE_TEXT}`);
  }
  if (stuckHidden) return hidden(`${stuckFlag}${HIDDEN_VALUE_TEXT}`);
  const name = before !== undefined && FLAG_WORD.test(before) && !word.startsWith('-') ? before : '';
  if (secretValue(name, word)) return hidden(HIDDEN_VALUE_TEXT);
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
    ...refusedCuts(word, glued === null ? name : gluedFlag, glued === null ? 0 : gluedFlag.length + separator.length),
  ];
  return cuts.length === 0 ? { text: word, hidden: false } : hidden(withCuts(word, cuts));
}

/** A command line's words as they may be shown, in order; `first` is the word before the first (an MCP command). */
export const shownWords = (words: readonly string[], first?: string): readonly ShownWord[] =>
  words.map((word, index) => shownWord(word, index === 0 ? first : words[index - 1]));

// ── The name and value tests ──────────────────────────────────────────────

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
 * THE list of well-known token formats (one owner): each is a fixed prefix and the body that follows it. A value that
 * starts with a prefix is a secret by value ({@link looksSecret}). Every body is a linear class of a minimum length and
 * no format looks behind it. A new format is added here and nowhere else.
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

/** The regular expression source of any whole token in a text; a caller builds it with the `g` and `u` flags. */
export const SECRET_TOKEN_SOURCE: string = TOKEN_FORMATS.map(([prefix, body]) => `${prefix}${body}`).join('|');

/** Value prefixes of well-known token formats, and of two more whose body is not a plain run (a Google OAuth token, a JWT). */
const SECRET_VALUE_PREFIX = new RegExp(`^(?:${TOKEN_FORMATS.map(([prefix]) => prefix).join('|')}|ya29\\.|eyJ)`, 'u');

/** A value that only points somewhere else: `$NAME`, `${NAME}`, `${secret:NAME}`. */
const INDIRECT_VALUE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})$/u;

/**
 * Whether one environment entry looks like a secret (E7): the FLEET's rule, which refuses a secret written into an
 * environment.
 *
 * By NAME (a word such as `TOKEN` or `API_KEY`, {@link secretNamed}) or by VALUE (a well-known token prefix). A value
 * that is only a reference to another variable is not a secret, because it holds none, and a value shorter than the
 * secret store accepts is a flag rather than a credential (`AUTH=1`). What a word may SHOW asks the wider
 * {@link looksSecretShown}.
 */
export function looksSecret(name: string, value: string): boolean {
  if (value.length < MIN_SECRET_VALUE_LENGTH || pointsElsewhere(value)) return false;
  if (SECRET_VALUE_PREFIX.test(value)) return true;
  return secretNamed(name);
}

/**
 * {@link looksSecret} with the name test widened to {@link secretNamedShown}, for a word that is only being SHOWN: the
 * mask over-hides, and a name W refuses ({@link namesCredential}) is a name it cuts.
 */
export function looksSecretShown(name: string, value: string): boolean {
  if (value.length < MIN_SECRET_VALUE_LENGTH || pointsElsewhere(value)) return false;
  if (SECRET_VALUE_PREFIX.test(value)) return true;
  return secretNamedShown(name);
}

/** Whether a value only points at one (`$NAME`, `${NAME}`, a `${secret:NAME}` in it), and so holds none. */
export const pointsElsewhere = (value: string): boolean => INDIRECT_VALUE.test(value) || holdsSecretReference(value);

/**
 * The longest credential word {@link CREDENTIAL_KEY} ends in (`credentials`), with room to spare: the pattern is
 * anchored at the END of the key, so only this much of the key is ever shown to it.
 */
const CREDENTIAL_KEY_TAIL = 16;

/**
 * A key whose value is a credential by its name. Linear: anchored at the end, every alternative a fixed word, and only
 * the key's last {@link CREDENTIAL_KEY_TAIL} characters are ever tested.
 */
const CREDENTIAL_KEY = /(?:(?:key|token|secret|password|passwd)s?|credentials?)$/iu;

/** Whether a key ends in a credential word (`key`, `tokens`, `apitoken`, `credentials`): the write rule's tail test. */
export const endsInCredentialWord = (key: string): boolean => CREDENTIAL_KEY.test(key.slice(-CREDENTIAL_KEY_TAIL));

/**
 * Whether a flag or a key is named for a credential by the END of its name, dashes stripped (`--ssh-key`, `--apitoken`,
 * `SIGNING_KEY`). THE one name tail test: the write rule (W, `findFlagSecrets`) and the read mask both ask it, so a name
 * W refuses is a name the mask cuts. It is wider than {@link secretNamed}'s word test on purpose; the mask over-hides.
 */
export const namesCredential = (name: string): boolean => endsInCredentialWord(name.replaceAll('-', ''));

/** Whether a name says it holds a credential: its tail ({@link namesCredential}), or {@link secretNamed}. */
const secretNamedShown = (name: string): boolean => namesCredential(name) || secretNamed(name);

/** Whether a name says it holds a credential: a word such as `TOKEN`, or a pair such as `API_KEY` ({@link looksSecret}). */
export function secretNamed(name: string): boolean {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/u)
    .filter(Boolean);
  if (words.some(word => SECRET_NAME_WORDS.has(word))) return true;
  return words.some((word, index) => SECRET_NAME_PAIRS.has(`${word}_${words[index + 1] ?? ''}`));
}
