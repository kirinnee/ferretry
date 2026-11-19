import { describe, expect, test } from 'bun:test';
import { findLine, lineText, parsePatch, splitRows } from '../../contract/diff-hunks.ts';

const PATCH = [
  '@@ -1,4 +1,5 @@ function greet()',
  ' keep',
  '-old one',
  '-old two',
  '+new one',
  '+new two',
  '+new three',
  ' tail',
].join('\n');

describe('parsePatch', () => {
  test('numbers every line on the side it exists on', () => {
    const { hunks, stray } = parsePatch(PATCH);
    expect(stray).toBe(0);
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0]!;
    expect(hunk).toMatchObject({ oldStart: 1, oldCount: 4, newStart: 1, newCount: 5, section: 'function greet()' });
    expect(hunk.lines.map(l => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['context', 1, 1],
      ['del', 2, undefined],
      ['del', 3, undefined],
      ['add', undefined, 2],
      ['add', undefined, 3],
      ['add', undefined, 4],
      ['context', 4, 5],
    ]);
  });

  test('an added file is all additions from line 1 and a deleted file all removals', () => {
    const added = parsePatch('@@ -0,0 +1,2 @@\n+a\n+b').hunks[0]!;
    expect(added.lines.map(l => l.newLine)).toEqual([1, 2]);
    const removed = parsePatch('@@ -1,2 +0,0 @@\n-a\n-b').hunks[0]!;
    expect(removed.lines.map(l => l.oldLine)).toEqual([1, 2]);
  });

  test('a header with no count means one line, and several hunks restart their numbers from their own header', () => {
    const { hunks } = parsePatch('@@ -5 +5 @@\n-x\n+y\n@@ -20,2 +30,2 @@\n a\n-b\n+c');
    expect(hunks[0]).toMatchObject({ oldCount: 1, newCount: 1 });
    expect(hunks[1]?.lines.map(l => [l.oldLine, l.newLine])).toEqual([
      [20, 30],
      [21, undefined],
      [undefined, 31],
    ]);
  });

  test('the "No newline at end of file" marker marks the line above it, on either side, and is not a line', () => {
    const { hunks } = parsePatch('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n\\ No newline at end of file');
    expect(hunks[0]?.lines).toEqual([
      { kind: 'del', text: 'a', oldLine: 1, noNewline: true },
      { kind: 'add', text: 'a', newLine: 1, noNewline: true },
    ]);
  });

  test('a rename with no content change has no hunks; the patch is empty', () => {
    expect(parsePatch('')).toEqual({ hunks: [], stray: 0 });
  });

  test('an empty row inside a hunk is an empty context line (a trimmed space); a trailing newline is not one', () => {
    const { hunks } = parsePatch('@@ -1,3 +1,3 @@\n a\n\n b\n');
    expect(hunks[0]?.lines.map(l => [l.kind, l.text, l.oldLine, l.newLine])).toEqual([
      ['context', 'a', 1, 1],
      ['context', '', 2, 2],
      ['context', 'b', 3, 3],
    ]);
  });

  test('text that is not a diff line is counted, never thrown on and never kept as a line', () => {
    const { hunks, stray } = parsePatch('preamble\n@@ -1 +1 @@\n a\nGARBAGE\n\\ orphan');
    expect(stray).toBe(2);
    expect(hunks[0]?.lines).toHaveLength(1);
    expect(parsePatch('\\ no newline first').stray).toBe(1);
    expect(parsePatch('@@ -1 +1 @@\n\\ marker with no line above').stray).toBe(1);
  });

  test('content that looks like a marker is content: "+++ x" inside a hunk is an added line "++ x"', () => {
    const { hunks } = parsePatch('@@ -0,0 +1,2 @@\n+++ x\n+@@ -1 +1 @@');
    expect(hunks[0]?.lines.map(l => l.text)).toEqual(['++ x', '@@ -1 +1 @@']);
  });
});

describe('findLine', () => {
  const parsed = parsePatch(PATCH);
  test('left is the old file and right the new, each on exactly one row', () => {
    expect(findLine(parsed, 'left', 2)?.line.text).toBe('old one');
    expect(findLine(parsed, 'right', 2)?.line.text).toBe('new one');
    expect(findLine(parsed, 'right', 5)).toMatchObject({ hunk: 0, index: 6 });
  });
  test('a line no hunk shows is undefined (an outdated thread is listed, not placed)', () => {
    expect(findLine(parsed, 'right', 99)).toBeUndefined();
    expect(findLine(parsed, 'left', 5)).toBeUndefined();
  });
});

describe('splitRows', () => {
  test('pairs a removed run with the added run that replaced it, and leaves the longer run’s rest alone', () => {
    const rows = splitRows(parsePatch(PATCH).hunks[0]!);
    expect(rows.map(r => [r.left?.text, r.right?.text])).toEqual([
      ['keep', 'keep'],
      ['old one', 'new one'],
      ['old two', 'new two'],
      [undefined, 'new three'],
      ['tail', 'tail'],
    ]);
  });
  test('a pure deletion has nothing on the right and a pure addition nothing on the left', () => {
    expect(splitRows(parsePatch('@@ -1 +0,0 @@\n-a').hunks[0]!)).toEqual([{ left: expect.anything() }]);
    expect(splitRows(parsePatch('@@ -0,0 +1 @@\n+a').hunks[0]!)).toEqual([{ right: expect.anything() }]);
  });
  test('a removed line after an added one starts a new change run', () => {
    const rows = splitRows(parsePatch('@@ -1,2 +1,2 @@\n-a\n+b\n-c\n+d').hunks[0]!);
    expect(rows.map(r => [r.left?.text, r.right?.text])).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('lineText', () => {
  test('joins the text of the lines, one per row', () => {
    expect(lineText(parsePatch(PATCH).hunks[0]!.lines.slice(0, 2))).toBe('keep\nold one');
  });
});
