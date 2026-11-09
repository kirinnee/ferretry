// PARITY: packages/core/ferrets/daemon/lib/session/snapshot/screen-mask.ts and
// packages/plugins/terminals/daemon/lib/tmux/screen-mask.ts are byte-for-byte the same file (a Ferrets unit test
// compares them). Ferrets and Terminals share no module a helper may live in without a contract change, so each
// keeps its own copy; change both together.
import type { RedactionScope } from '@ferretry/kernel/contract';

/**
 * What a harness UI draws around the text it lays out, never part of a value it wrapped: whitespace, box drawing
 * (U+2500–U+257F: `│ ┃ ║ ╭ ╰ └ ├ ─`), block elements (U+2580–U+259F: `▌ █`), Claude Code's `⎿` and `⏺`, and the
 * bullets and prompts `• › ❯ >`.
 */
const GUTTER = /[\s─-▟⎿⏺•›❯>]/u;

/**
 * The most characters of one screen the masker takes. A screen is masked WHOLE or not at all (a value cut by a limit
 * would escape the mask), and the masking reads the screen several times over (a measured eight screens' worth: 500
 * dense values on a 200×2000 screen took 1.6 s of the main thread), so a screen past this is refused. A real pane is
 * far under it (400 columns by 200 rows is 80,000).
 */
const MAX_SCREEN_CHARS = 262_144;

/** How the visible pieces of a wrapped value meet once their gutters are gone. */
const JOINS = ['', ' ', '\n'] as const;

/** A piece of one row: the characters `[start, end)` of row `row`. */
interface Piece {
  readonly row: number;
  readonly start: number;
  readonly end: number;
}

/** The row's content: what is left once the leading indent or marker and the trailing border are taken off. */
function contentOf(row: string, index: number): Piece {
  let start = 0;
  let end = row.length;
  while (start < end && GUTTER.test(row.charAt(start))) start += 1;
  while (end > start && GUTTER.test(row.charAt(end - 1))) end -= 1;
  return { row: index, start, end };
}

/**
 * Which reading `pieces` joined by `join` is: two readings with one key ask `scope.lines` the very same lines, so
 * the second can add no mark and is skipped. A single piece meets nothing, so its join does not count.
 */
function readingOf(pieces: readonly Piece[], join: string): string {
  return `${pieces.length > 1 ? JSON.stringify(join) : ''}|${pieces.map(piece => `${piece.start}:${piece.end}`).join(',')}`;
}

/**
 * Marks in `hidden` every character of `pieces` that `scope.lines` covers when the pieces are read as one run, each
 * meeting the next with `join`. `lines` keeps each line's length, so a `*` maps back to its row and column exactly; a
 * line that comes back with another length is not trusted, and its whole piece is hidden (closed, never open). A `*`
 * the screen already showed is not a mark.
 */
function cover(
  scope: RedactionScope,
  rows: readonly string[],
  pieces: readonly Piece[],
  join: string,
  hidden: boolean[][],
): void {
  const asked = pieces.map(
    (piece, at) => rows[piece.row]?.slice(piece.start, piece.end) + (at < pieces.length - 1 ? join : ''),
  );
  const masked = scope.lines(asked);
  pieces.forEach((piece, at) => {
    const before = asked[at] ?? '';
    const after = masked[at];
    const marks = hidden[piece.row] as boolean[];
    for (let column = piece.start; column < piece.end; column += 1) {
      const offset = column - piece.start;
      if (after === undefined || after.length !== before.length) marks[column] = true;
      else if (after.charAt(offset) === '*' && before.charAt(offset) !== '*') marks[column] = true;
    }
  });
}

/**
 * A captured screen with every value the Vault holds masked, inside the one read scope it is given, however the
 * screen broke it across rows:
 * - at the pane's edge by tmux (`capture-pane` without `-J`): the rows read as one run;
 * - by the harness UI itself, which hard-breaks a word longer than its box and starts each continuation row with
 *   the box's indent or border (`  ⎿  head` then `     tail`, `⏺ head` then `  tail`, `│ head │` then `│ tail │`):
 *   each row's CONTENT ({@link contentOf}) reads as one run with the others;
 * - with a space at the break that `capture-pane` trimmed off the row's end, or across a real line break: each run
 *   is read again with the pieces meeting at `' '` and at `'\n'` ({@link JOINS}).
 *
 * Every reading is made over the RAW screen and the coverage of all of them is merged, so a longer value that holds a
 * shorter one is never hidden from a later reading by an earlier mask. A row whose only matches lie wholly inside it
 * keeps today's `[redacted:NAME]` marker (`scope.text`, run last over the whole screen); any other masked row has `*`
 * over exactly the covered characters, keeping its width. A reading that joins unrelated rows can only add `*`, never remove one.
 *
 * Not covered (GAP(snapshot-wrap)): the end of a value whose start has scrolled off the top of the screen; a break
 * whose continuation starts or ends with a character the UI draws that {@link GUTTER} does not name; a value in a table
 * column that is not the last (the next column's border and cells stand between its pieces); a value broken
 * over three or more rows where the breaks meet in different ways (one with a space, one without).
 *
 * A screen over {@link MAX_SCREEN_CHARS} is REFUSED (a `RangeError` that says only the two sizes, never a character of
 * the screen), before the scope is asked anything: it is never cut and then masked, and never handed on unmasked.
 */
export function maskedScreen(scope: RedactionScope, screen: string): string {
  if (screen.length > MAX_SCREEN_CHARS)
    throw new RangeError(
      `the screen is too large to mask (${screen.length} characters; the most is ${MAX_SCREEN_CHARS})`,
    );
  const rows = screen.split('\n');
  const hidden = rows.map(row => Array.from({ length: row.length }, () => false));
  const whole = rows.map((row, index) => ({ row: index, start: 0, end: row.length }));
  const content = rows.map(contentOf);
  // A screen whose rows draw no gutter has content equal to its whole rows: each reading is made once.
  const read = new Set<string>();
  for (const join of JOINS)
    for (const pieces of [whole, content]) {
      const reading = readingOf(pieces, join);
      if (read.has(reading)) continue;
      read.add(reading);
      cover(scope, rows, pieces, join, hidden);
    }
  const starred = rows.map((row, index) => {
    const marks = hidden[index] as boolean[];
    if (!marks.includes(true)) return row;
    const inside = scope.lines([row])[0];
    const onlyInside =
      inside !== undefined &&
      inside.length === row.length &&
      marks.every((mark, column) => mark === (inside.charAt(column) === '*' && row.charAt(column) !== '*'));
    // Left whole for `text` below, which puts today's marker where the value stood.
    if (onlyInside) return row;
    let out = '';
    for (let column = 0; column < row.length; column += 1) out += marks[column] === true ? '*' : row.charAt(column);
    return out;
  });
  // Last, over the whole screen: every value still standing whole (in a row, or across a real line break) gets its
  // marker. What the readings above covered is already `*` and cannot be matched again.
  return scope.text(starred.join('\n'));
}
