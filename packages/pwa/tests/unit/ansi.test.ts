import { describe, expect, it } from 'bun:test';
import { findMatches, lineText, parseAnsi, segmentLine } from '../../src/lib/ansi.ts';

describe('parsing ANSI output', () => {
  it('reads plain text into lines and ignores one trailing newline', () => {
    const lines = parseAnsi('one\ntwo\n');
    expect(lines.map(lineText)).toEqual(['one', 'two']);
    expect(parseAnsi('')).toEqual([]);
  });

  it('colours a span and resets it', () => {
    const [line] = parseAnsi('\u001b[31mred\u001b[0m plain');
    expect(line?.[0]?.text).toBe('red');
    expect(line?.[0]?.style.fg).toEqual({ palette: 1 });
    expect(line?.[1]?.text).toBe(' plain');
    expect(line?.[1]?.style.fg).toBeUndefined();
  });

  it('carries style across a newline and reads bright, 256-colour and 24-bit colour', () => {
    const lines = parseAnsi('\u001b[1;92mgo\nstill\u001b[22;39m done\n\u001b[38;5;196mA\u001b[48;2;1;2;3mB');
    expect(lines[0]?.[0]?.style).toMatchObject({ bold: true, fg: { palette: 10 } });
    expect(lines[1]?.[0]?.style).toMatchObject({ bold: true, fg: { palette: 10 } });
    expect(lines[1]?.[1]?.style.bold).toBe(false);
    expect(lines[2]?.[0]?.style.fg).toEqual({ rgb: 'rgb(255,0,0)' });
    expect(lines[2]?.[1]?.style.bg).toEqual({ rgb: 'rgb(1,2,3)' });
  });

  it('maps the 256-colour greyscale ramp and ignores an unknown extended-colour mode', () => {
    const [grey] = parseAnsi('\u001b[38;5;232mdark\u001b[48;5;255mlight');
    expect(grey?.[0]?.style.fg).toEqual({ rgb: 'rgb(8,8,8)' });
    expect(grey?.[1]?.style.bg).toEqual({ rgb: 'rgb(238,238,238)' });
    const [odd] = parseAnsi('\u001b[31m\u001b[38;9mstill red');
    expect(odd?.[0]?.text).toBe('still red');
    expect(odd?.[0]?.style.fg).toEqual({ palette: 1 });
  });

  it('merges neighbours that look the same and splits at any attribute that differs', () => {
    expect(parseAnsi('ab\u001b[mcd')[0]).toHaveLength(1);
    expect(parseAnsi('a\u001b[1m\u001b[22mb')[0]?.map(span => span.text)).toEqual(['ab']);
    const splits = (on: number, off: number): readonly string[] | undefined =>
      parseAnsi(`a\u001b[${on}mb\u001b[${off}mc`)[0]?.map(span => span.text);
    for (const [on, off] of [
      [1, 22],
      [2, 22],
      [3, 23],
      [4, 24],
      [9, 29],
      [7, 27],
    ] as const)
      expect(splits(on, off)).toEqual(['a', 'b', 'c']);
    expect(parseAnsi('\u001b[31ma\u001b[41mb')[0]).toHaveLength(2);
    expect(parseAnsi('\u001b[31ma\u001b[32mb')[0]).toHaveLength(2);
  });

  it('drops every other escape instead of showing it', () => {
    const text = 'a\u001b[2K\u001b[1Ab\u001b]0;title\u0007c\u001b]8;;http://x\u001b\\d\u001b(Be\u0007\u0001f';
    expect(parseAnsi(text).map(lineText)).toEqual(['abcdef']);
  });

  it('treats a lone carriage return as a redraw and CRLF as a newline', () => {
    expect(parseAnsi('10%\r50%\r100%\ndone\r\nend').map(lineText)).toEqual(['100%', 'done', 'end']);
  });

  it('keeps markup as text and never produces anything but strings', () => {
    const hostile = '<img src=x onerror="alert(1)"> \u001b[31m<script>boom()</script>\u001b[0m';
    const lines = parseAnsi(hostile);
    expect(lineText(lines[0] ?? [])).toBe('<img src=x onerror="alert(1)"> <script>boom()</script>');
    for (const span of lines.flat()) {
      expect(typeof span.text).toBe('string');
      expect(Object.keys(span).sort()).toEqual(['style', 'text']);
    }
  });

  it('survives an escape cut off at the end of a read', () => {
    expect(parseAnsi('ok\u001b[3').map(lineText)).toEqual(['ok']);
    expect(parseAnsi('ok\u001b').map(lineText)).toEqual(['ok']);
  });
});

describe('searching parsed output', () => {
  const lines = parseAnsi('Error: one\nok\n\u001b[31merror\u001b[0m: two ERROR');

  it('finds every case-insensitive match in reading order', () => {
    const matches = findMatches(lines, 'error');
    expect(matches).toEqual([
      { line: 0, start: 0, end: 5 },
      { line: 2, start: 0, end: 5 },
      { line: 2, start: 11, end: 16 },
    ]);
    expect(findMatches(lines, '')).toEqual([]);
    expect(findMatches(lines, 'absent')).toEqual([]);
  });

  it('cuts a styled line at the edges of a match without losing text or style', () => {
    const line = lines[2] ?? [];
    const segments = segmentLine(line, [
      { start: 0, end: 5, index: 1 },
      { start: 11, end: 16, index: 2 },
    ]);
    expect(segments.map(segment => segment.text).join('')).toBe(lineText(line));
    expect(segments.filter(segment => segment.match !== undefined).map(segment => segment.match)).toEqual([1, 2]);
    expect(segments[0]?.style.fg).toEqual({ palette: 1 });
  });

  it('splits a match that spans two styled spans', () => {
    const [line] = parseAnsi('ab\u001b[32mcd\u001b[0mef');
    const segments = segmentLine(line ?? [], [{ start: 1, end: 5, index: 0 }]);
    expect(segments.map(segment => [segment.text, segment.match])).toEqual([
      ['a', undefined],
      ['b', 0],
      ['cd', 0],
      ['e', 0],
      ['f', undefined],
    ]);
  });
});
