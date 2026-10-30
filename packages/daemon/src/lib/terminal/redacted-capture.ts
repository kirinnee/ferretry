import type { TextRange, TextRedactor } from '../secrets/redaction.ts';
import type { TerminalCapture } from './redraw.ts';

/**
 * A PANE CAPTURE WITH EVERY KNOWN SECRET MASKED BY CELL, for a viewer.
 *
 * The operator's screen and an agent's read are scrubbed; the live stream the app draws is the same pane,
 * so it must be too. A capture is rows of cells carrying colour codes, and a value that wrapped sits split
 * across two rows. So each row is split into its cells, the cells' characters are read as one text joined
 * end to end, and the redactor is asked WHERE a known value sits in it (positions, never the value). Exactly
 * those cells are overwritten in place with a fill of the same width, so a masked screen has the very shape
 * of the real one: the same rows, the same columns, the same cursor, colours untouched, and no text is
 * rewritten, so there is nothing to realign and no marker that can collide with another value.
 */

const ESC = '\u001b';
const ESCAPE = new RegExp(`${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)|.)`, 'suy');
const NO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
// East Asian wide ranges (UAX #11 W/F, as xterm and tmux count them): U+303F and the halfwidth forms are one cell.
const WIDE =
  /^(?:[\u{1100}-\u{115F}\u{2E80}-\u{303E}\u{3041}-\u{33FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{A000}-\u{A4CF}\u{A960}-\u{A97F}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE30}-\u{FE6F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation})$/u;
const FILL = '*';

/** One character of a row, with the colour codes that come before it. */
interface Cell {
  readonly prefix: string;
  readonly char: string;
  readonly width: number;
  /** Whether this cell is drawn on a background (or reversed): a blank one is paint, not padding. */
  readonly painted: boolean;
}

interface Row {
  readonly cells: readonly Cell[];
  /** The codes after the last character (tmux ends a row with a reset). */
  readonly tail: string;
  /** Whether an escape that is not a colour code was dropped from this row: the row must be rewritten. */
  readonly stripped: boolean;
}

const SGR = new RegExp(`${ESC}\\[([0-9;:]*)m`, 'gu');
const SGR_CODE = new RegExp(`^${ESC}\\[[0-9;:]*m$`, 'u');

/** What paints a blank cell: a background colour and reverse video are tracked apart, each cleared only by its own reset. */
interface Paint {
  readonly background: boolean;
  readonly reverse: boolean;
}

const UNPAINTED: Paint = { background: false, reverse: false };

/** The paint after `codes`, given the paint before. */
function paintAfter(codes: string, before: Paint): Paint {
  let { background, reverse } = before;
  for (const [, params = ''] of codes.matchAll(SGR)) {
    const groups = params === '' ? ['0'] : params.split(';');
    for (let at = 0; at < groups.length; at += 1) {
      const group = groups[at] ?? '';
      const code = Number(group.split(':')[0]);
      if (code === 38 || code === 48) {
        if (code === 48) background = true;
        // A colon group carries its own colour; a semicolon one is followed by 2 (index) or 4 (rgb) more.
        if (!group.includes(':')) at += groups[at + 1] === '5' ? 2 : 4;
      } else if (code === 0) {
        background = false;
        reverse = false;
      } else if (code === 49) background = false;
      else if (code === 27) reverse = false;
      else if (code === 7) reverse = true;
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) background = true;
    }
  }
  return { background, reverse };
}

const widthOf = (char: string): number => (NO_WIDTH.test(char) ? 0 : WIDE.test(char) ? 2 : 1);

function cellsOf(line: string): Row {
  const cells: Cell[] = [];
  let prefix = '';
  let paint = UNPAINTED;
  let stripped = false;
  let at = 0;
  while (at < line.length) {
    ESCAPE.lastIndex = at;
    const code = ESCAPE.exec(line);
    if (code !== null) {
      // Only colour codes are kept: any other escape (a hyperlink's URL, a title) is metadata that can carry a value.
      if (SGR_CODE.test(code[0])) prefix += code[0];
      else stripped = true;
      at += code[0].length;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(at) ?? 0);
    paint = paintAfter(prefix, paint);
    cells.push({ prefix, char, width: widthOf(char), painted: paint.background || paint.reverse });
    prefix = '';
    at += char.length;
  }
  return { cells, tail: prefix, stripped };
}

function redactRows(capture: TerminalCapture, ranges: (text: string) => readonly TextRange[]): TerminalCapture {
  const rows = capture.lines.map(line => ({ line, row: cellsOf(line) }));
  const covered = ranges(rows.map(({ row }) => row.cells.map(cell => cell.char).join('')).join(''));
  let offset = 0;
  let next = 0;
  const lines = rows.map(({ line, row }) => {
    let touched = row.stripped;
    const cells = row.cells.map(cell => {
      const start = offset;
      offset += cell.char.length;
      let range = covered[next];
      while (range !== undefined && range.end <= start) {
        next += 1;
        range = covered[next];
      }
      if (range === undefined || range.start >= offset)
        return { text: cell.prefix + cell.char, blank: cell.char === ' ' && !cell.painted };
      touched = true;
      return { text: cell.prefix + FILL.repeat(cell.width), blank: false };
    });
    let keep = cells.length;
    while (keep > 0 && cells[keep - 1]?.blank === true) keep -= 1;
    return touched || keep !== cells.length
      ? cells
          .slice(0, keep)
          .map(cell => cell.text)
          .join('') +
          row.cells
            .slice(keep)
            .map(cell => cell.prefix)
            .join('') +
          row.tail
      : line;
  });
  return lines.every((line, index) => line === capture.lines[index]) ? capture : { ...capture, lines };
}

/**
 * `capture` with every secret the redactor knows overwritten cell for cell, and the spaces ending each row dropped
 * AFTER that: the capture keeps them (a value may end in spaces, and trimmed they could not be found), the viewer
 * does not need them. A redactor that fails fails the capture: nothing unmasked is returned.
 */
export async function redactCapture(capture: TerminalCapture, redactor: TextRedactor): Promise<TerminalCapture> {
  return await redactor.batch(scrub => redactRows(capture, text => scrub.cover(text)));
}
