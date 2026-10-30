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
const WIDE = /^(?:[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation})$/u;
const FILL = '*';

/** One character of a row, with the colour codes that come before it. */
interface Cell {
  readonly prefix: string;
  readonly char: string;
  readonly width: number;
}

interface Row {
  readonly cells: readonly Cell[];
  /** The codes after the last character (tmux ends a row with a reset). */
  readonly tail: string;
}

const widthOf = (char: string): number => (NO_WIDTH.test(char) ? 0 : WIDE.test(char) ? 2 : 1);

function cellsOf(line: string): Row {
  const cells: Cell[] = [];
  let prefix = '';
  let at = 0;
  while (at < line.length) {
    ESCAPE.lastIndex = at;
    const code = ESCAPE.exec(line);
    if (code !== null) {
      prefix += code[0];
      at += code[0].length;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(at) ?? 0);
    cells.push({ prefix, char, width: widthOf(char) });
    prefix = '';
    at += char.length;
  }
  return { cells, tail: prefix };
}

function redactRows(capture: TerminalCapture, ranges: (text: string) => readonly TextRange[]): TerminalCapture {
  const rows = capture.lines.map(line => ({ line, row: cellsOf(line) }));
  const covered = ranges(rows.map(({ row }) => row.cells.map(cell => cell.char).join('')).join(''));
  let offset = 0;
  let next = 0;
  const lines = rows.map(({ line, row }) => {
    let touched = false;
    const cells = row.cells.map(cell => {
      const start = offset;
      offset += cell.char.length;
      let range = covered[next];
      while (range !== undefined && range.end <= start) {
        next += 1;
        range = covered[next];
      }
      if (range === undefined || range.start >= offset)
        return { text: cell.prefix + cell.char, blank: cell.char === ' ' };
      touched = true;
      return { text: cell.prefix + FILL.repeat(cell.width), blank: false };
    });
    let keep = cells.length;
    while (keep > 0 && cells[keep - 1]?.blank === true) keep -= 1;
    return touched || keep !== cells.length
      ? cells
          .slice(0, keep)
          .map(cell => cell.text)
          .join('') + row.tail
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
