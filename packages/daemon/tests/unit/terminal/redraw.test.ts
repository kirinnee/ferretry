import { describe, it } from 'bun:test';
import should from 'should';
import {
  parseTerminalCapture,
  planTerminalRedraw,
  type TerminalCapture,
  terminalFullRedraw,
} from '../../../src/lib/terminal/index.ts';

const ESC = '\u001b';
const FULL = `${ESC}[3J${ESC}[2J${ESC}[H`;
const ROW = `${ESC}[0m${ESC}[2K`;
const BIG = 1_000_000;

/** A pane `rows` tall showing the last `rows` of `lines`, the cursor at the end of the last row by default. */
const capture = (lines: readonly string[], rows: number, cursor?: { x: number; y: number }): TerminalCapture => ({
  lines,
  cols: 80,
  rows,
  cursorX: cursor?.x ?? 0,
  cursorY: cursor?.y ?? 0,
  historySize: lines.length - rows,
});
const FULL_PLAN = { kind: 'full' } as const;
const delta = (frame: string) => ({ kind: 'delta', frame }) as const;
const viewer = { cols: 80, rows: 2 };

describe('terminalFullRedraw', () => {
  it('should erase everything, then write the history and the screen top to bottom, and place the cursor', () => {
    // Act
    const frame = terminalFullRedraw(capture(['h1', 'h2', 's1', 's2'], 2, { x: 3, y: 1 }), BIG);

    // Assert
    should(frame).equal(`${FULL}h1\r\nh2\r\ns1\r\ns2${ESC}[2;4H`);
  });

  it('should drop the OLDEST history to fit the budget, never the screen', () => {
    // Arrange — the screen and one history line (2 bytes and its CRLF) fit; a second does not.
    const pane = capture(['old', 'new', 's1', 's2'], 2);
    const screenOnly = terminalFullRedraw(capture(['s1', 's2'], 2), BIG);

    // Act
    const frame = terminalFullRedraw(pane, new TextEncoder().encode(screenOnly).byteLength + 'new\r\n'.length);

    // Assert
    should(frame).equal(`${FULL}new\r\ns1\r\ns2${ESC}[1;1H`);
  });

  it('should count history in UTF-8 bytes, wide characters included', () => {
    // Arrange — "é€😀" is 2 + 3 + 4 bytes; a lone high surrogate is the three-byte replacement.
    const wide = 'é€😀\ud800';
    const screenOnly = new TextEncoder().encode(terminalFullRedraw(capture(['s'], 1), BIG)).byteLength;
    const wideBytes = new TextEncoder().encode(wide).byteLength;

    // Act
    const fits = terminalFullRedraw(capture([wide, 's'], 1), screenOnly + wideBytes + 2);
    const short = terminalFullRedraw(capture([wide, 's'], 1), screenOnly + wideBytes + 1);

    // Assert
    should(wideBytes).equal(12);
    should(fits).equal(`${FULL}${wide}\r\ns${ESC}[1;1H`);
    should(short).equal(`${FULL}s${ESC}[1;1H`);
  });

  it('should still return the screen when the screen alone is over the budget', () => {
    // A screen no record can carry is the carrier's to refuse; there is no smaller honest picture.
    should(terminalFullRedraw(capture(['h', 's1', 's2'], 2), 1)).equal(`${FULL}s1\r\ns2${ESC}[1;1H`);
  });

  it('should normalise a cursor that is negative, fractional or not a number', () => {
    // Act
    const pane = { lines: ['s'], cols: 80, rows: 1, historySize: 0 };
    const frame = terminalFullRedraw({ ...pane, cursorX: -4, cursorY: Number.NaN }, BIG);
    const fractional = terminalFullRedraw({ ...pane, cursorX: 2.7, cursorY: 0.2 }, BIG);

    // Assert
    should(frame).endWith(`${ESC}[1;1H`);
    should(fractional).endWith(`${ESC}[1;3H`);
  });
});

describe('planTerminalRedraw', () => {
  const prompt = capture(['h1', '$ ', ''], 2, { x: 2, y: 0 });

  it('should ask for a complete redraw when there is nothing to be a delta against', () => {
    should(planTerminalRedraw(undefined, prompt, viewer, BIG)).deepEqual(FULL_PLAN);
  });

  it('should send nothing for an unchanged pane, whether or not the viewer reported a size', () => {
    // Act + Assert — an equal copy, not the same object: what is compared is the picture.
    should(planTerminalRedraw(prompt, { ...prompt, lines: [...prompt.lines] }, viewer, BIG)).deepEqual({
      kind: 'unchanged',
    });
    should(planTerminalRedraw(prompt, prompt, undefined, BIG)).deepEqual({ kind: 'unchanged' });
  });

  it("should compare a poll's window of history with a complete capture by their newest lines", () => {
    // Arrange — the last frame read the whole history; this poll read only its newest line.
    const deep = capture(['h0', 'h1', '$ ', ''], 2, { x: 2, y: 0 });
    const window = { ...capture(['h1', '$ ', ''], 2, { x: 2, y: 0 }), historySize: 2 };

    // Act + Assert
    should(planTerminalRedraw(deep, window, viewer, BIG)).deepEqual({ kind: 'unchanged' });
    should(planTerminalRedraw(deep, { ...window, lines: ['hX', '$ ', ''] }, viewer, BIG)).deepEqual(FULL_PLAN);
  });

  it('should not mistake a cleared history for an unchanged pane when the screen is the same', () => {
    // Arrange — `clear-history`: the screen stays, the pane's history count drops to nothing.
    const cleared = { ...capture(['$ ', ''], 2, { x: 2, y: 0 }), historySize: 0 };

    // Act + Assert
    should(planTerminalRedraw(prompt, cleared, viewer, BIG)).deepEqual(FULL_PLAN);
  });

  it('should ask for a complete redraw for a viewer that has not said its size, or whose size is not the pane', () => {
    // Arrange
    const typed = capture(['h1', '$ a', ''], 2, { x: 3, y: 0 });

    // Act + Assert
    should(planTerminalRedraw(prompt, typed, undefined, BIG)).deepEqual(FULL_PLAN);
    should(planTerminalRedraw(prompt, typed, { cols: 81, rows: 2 }, BIG)).deepEqual(FULL_PLAN);
    should(planTerminalRedraw(prompt, typed, { cols: 80, rows: 3 }, BIG)).deepEqual(FULL_PLAN);
  });

  it('should ask for a complete redraw when the pane itself changed size since the last frame', () => {
    // Arrange — another viewer resized the pane; this one now matches it, but the last picture does not.
    const wider = { ...capture(['h1', '$ a', ''], 2), cols: 100 };
    const taller = capture(['$ a', '', ''], 3);

    // Act + Assert
    should(planTerminalRedraw(prompt, wider, { cols: 100, rows: 2 }, BIG)).deepEqual(FULL_PLAN);
    should(planTerminalRedraw(prompt, taller, { cols: 80, rows: 3 }, BIG)).deepEqual(FULL_PLAN);
  });

  it('should repaint only the rows that changed when nothing scrolled, then place the cursor', () => {
    // Arrange
    const typed = capture(['h1', '$ a', 'b'], 2, { x: 1, y: 1 });

    // Act
    const planned = planTerminalRedraw(prompt, typed, viewer, BIG);

    // Assert — each changed row is addressed, reset, erased and written; the unchanged history is not.
    should(planned).deepEqual(delta(`${ESC}[1;1H${ROW}$ a${ESC}[2;1H${ROW}b${ESC}[2;2H`));
  });

  it('should send only a cursor move when the rows are the same and the cursor is not', () => {
    should(planTerminalRedraw(prompt, capture(['h1', '$ ', ''], 2, { x: 0, y: 1 }), viewer, BIG)).deepEqual(
      delta(`${ESC}[2;1H`),
    );
  });

  it('should push only the newly scrolled lines through the screen when output scrolled', () => {
    // Arrange — two lines left the screen for the history: "$ ls" and "a".
    const scrolled = capture(['h1', '$ ls', 'a', 'b', '$ '], 2, { x: 2, y: 1 });
    const before = capture(['h1', '$ ls', ''], 2, { x: 4, y: 0 });

    // Act
    const planned = planTerminalRedraw(before, scrolled, viewer, BIG);

    // Assert — from the top-left: the two scrolled lines, then the screen; the old history is untouched.
    should(planned).deepEqual(delta(`${ESC}[H${ROW}$ ls\r\n${ROW}a\r\n${ROW}b\r\n${ROW}$ ${ESC}[2;3H`));
  });

  it('should follow a history that slid at the capture limit, its oldest lines dropped as new ones arrived', () => {
    // Arrange — the same history length on both sides (tmux's count stays at its limit), shifted by one.
    const before = capture(['h1', 'h2', 'h3', 's1', 's2'], 2);
    const after = capture(['h2', 'h3', 's1', 's2', 's3'], 2);

    // Act + Assert
    should(planTerminalRedraw(before, after, viewer, BIG)).deepEqual(
      delta(`${ESC}[H${ROW}s1\r\n${ROW}s2\r\n${ROW}s3${ESC}[1;1H`),
    );
  });

  it('should accept any history after an empty one, which is the return from an alternate screen', () => {
    // Arrange — the alternate screen has no history; leaving it brings the shell's history back.
    const editor = capture(['~', '~'], 2);
    const shell = capture(['h1', 'h2', '$ ', ''], 2, { x: 2, y: 0 });

    // Act + Assert
    should(planTerminalRedraw(editor, shell, viewer, BIG)).deepEqual(
      delta(`${ESC}[H${ROW}h1\r\n${ROW}h2\r\n${ROW}$ \r\n${ROW}${ESC}[1;3H`),
    );
  });

  it('should ask for a complete redraw when the history was cleared or rewritten rather than grown', () => {
    // Arrange
    const before = capture(['h1', 'h2', 's1', 's2'], 2);

    // Act + Assert — gone entirely, and replaced by lines that do not continue it.
    should(planTerminalRedraw(before, capture(['s1', 's3'], 2), viewer, BIG)).deepEqual(FULL_PLAN);
    should(planTerminalRedraw(before, capture(['x1', 'x2', 's1', 's3'], 2), viewer, BIG)).deepEqual(FULL_PLAN);
    // Its newest line still matches, but what came before it does not.
    should(planTerminalRedraw(before, capture(['x1', 'h2', 's1', 's3'], 2), viewer, BIG)).deepEqual(FULL_PLAN);
  });

  it('should give up aligning a history of identical lines rather than compare it without end', () => {
    // Arrange — every line is blank, so every alignment passes the cheap test; none is the true one.
    const blanks = Array.from({ length: 12 }, () => '');
    const before = capture([...blanks, 'x', '', 's1', 's2'], 2);
    const after = capture([...blanks, 'y', '', 's1', 's3'], 2);

    // Act + Assert
    should(planTerminalRedraw(before, after, viewer, BIG)).deepEqual(FULL_PLAN);
  });

  it('should keep the newest scrolled lines and the whole screen when a scroll is over the budget', () => {
    // Arrange — two lines scrolled, room for one of them.
    const before = capture(['h1', 's1', 's2'], 2);
    const after = capture(['h1', 'a1', 'a2', 's1', 's2'], 2);
    const one = planTerminalRedraw(before, capture(['h1', 'a2', 's1', 's2'], 2), viewer, BIG);
    const budget = one.kind === 'delta' ? new TextEncoder().encode(one.frame).byteLength : 0;

    // Act
    const planned = planTerminalRedraw(before, after, viewer, budget);

    // Assert — "a1" is left out of the viewer's scrollback; the screen is complete.
    should(planned).deepEqual(delta(`${ESC}[H${ROW}a2\r\n${ROW}s1\r\n${ROW}s2${ESC}[1;1H`));
  });
});

describe('parseTerminalCapture', () => {
  it('should read the rows, then the cursor and the size from the geometry line after them', () => {
    should(parseTerminalCapture('history\n$ ls\n\n2|1|80|2|1500\n')).deepEqual({
      lines: ['history', '$ ls', ''],
      cursorX: 2,
      cursorY: 1,
      cols: 80,
      rows: 2,
      historySize: 1500,
    });
  });

  it('should keep a picture whose geometry line does not parse, with the cursor home', () => {
    // Act
    const garbled = parseTerminalCapture('one\ntwo\nnot|a|geometry\n');
    const empty = parseTerminalCapture('one\n|||\n');

    // Assert — the screen is every row there is, and there is no width to match a viewer against.
    should(garbled).deepEqual({ lines: ['one', 'two'], cursorX: 0, cursorY: 0, cols: 0, rows: 2, historySize: 0 });
    should(empty).deepEqual({ lines: ['one'], cursorX: 0, cursorY: 0, cols: 0, rows: 1, historySize: 0 });
  });

  it('should never claim more screen rows than were captured, nor a negative cursor', () => {
    should(parseTerminalCapture('only\n-3|-1|80|30\n')).deepEqual({
      lines: ['only'],
      cursorX: 0,
      cursorY: 0,
      cols: 80,
      rows: 1,
      historySize: 0,
    });
  });
});
