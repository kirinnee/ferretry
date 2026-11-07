/**
 * A screen buffer with no emulator behind it: rows of text laid out as xterm lays out cells, so the link
 * detection is driven against the same shapes (wrapped continuations, wide characters that take two
 * cells) without a canvas.
 */

import type { LinkableBuffer, LinkableCell, LinkableLine } from '../../src/lib/terminal-links.ts';

/** One screen row: its text, and whether the emulator marked it a continuation of the row above. */
export type BufferRow = string | { readonly text: string; readonly wrapped: true };

/** CJK and fullwidth forms take two cells; the second carries no character. */
const isWide = (char: string): boolean => /[ᄀ-ᅟ⺀-꓏가-힣＀-｠]/u.test(char);

const cellsOf = (text: string, columns: number): LinkableCell[] => {
  const cells: LinkableCell[] = [];
  for (const char of text) {
    const width = isWide(char) ? 2 : 1;
    cells.push({ getChars: () => char, getWidth: () => width });
    if (width === 2) cells.push({ getChars: () => '', getWidth: () => 0 });
  }
  while (cells.length < columns) cells.push({ getChars: () => '', getWidth: () => 1 });
  return cells.slice(0, columns);
};

const lineOf = (row: BufferRow, columns: number): LinkableLine => {
  const text = typeof row === 'string' ? row : row.text;
  const cells = cellsOf(text, columns);
  return {
    isWrapped: typeof row !== 'string',
    length: columns,
    getCell: x => cells[x],
    translateToString: (trimRight = false, start = 0, end = columns) => {
      const slice = cells
        .slice(start, end)
        .map(cell => cell.getChars())
        .join('');
      return trimRight ? slice.trimEnd() : slice;
    },
  };
};

export const terminalBuffer = (rows: readonly BufferRow[], columns = 20): LinkableBuffer => {
  const lines = rows.map(row => lineOf(row, columns));
  return { getLine: y => lines[y] };
};
