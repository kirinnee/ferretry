import { describe, expect, it } from 'bun:test';
import {
  fileHead,
  holdsMarker,
  isLargeFile,
  LARGE_FILE_BYTES,
  namedByWarning,
  reviewRows,
  splitMarkers,
  warningRows,
} from '../../../app/lib/review-model.ts';

describe('how a local-copy review is read', () => {
  it('draws a document entry as a file and any other entry as a line, in the order the daemon gave them', () => {
    const rows = reviewRows([
      { label: 'Skill file SKILL.md', text: '# a\nb', document: true },
      { label: 'Environment TOKEN', text: 'x', document: false },
    ]);
    expect(rows[0]).toMatchObject({ kind: 'file', path: 'SKILL.md', lines: 2, marked: false, large: false });
    expect(rows[1]).toMatchObject({ kind: 'line', label: 'Environment TOKEN', text: 'x' });
  });

  it('writes a raw hidden character out as its marker and flags the file, so none reaches the screen', () => {
    const [row] = reviewRows([{ label: 'Skill file a.md', text: `ok‮evil`, document: true }]);
    expect(row?.kind === 'file' && row.text).toBe('ok⟨U+202E⟩evil');
    expect(row?.marked).toBe(true);
    expect(holdsMarker('plain')).toBe(false);
  });

  it('counts a run of the same marker once instead of drawing a million marks', () => {
    const segments = splitMarkers(`a${'⟨U+200B⟩'.repeat(1000)}b`);
    expect(segments).toEqual([
      { marker: false, text: 'a' },
      { marker: true, text: '⟨U+200B ×1,000⟩' },
      { marker: false, text: 'b' },
    ]);
  });

  it('closes a big file, or one with many markers, until it is opened', () => {
    expect(isLargeFile('x'.repeat(LARGE_FILE_BYTES + 1))).toBe(true);
    expect(isLargeFile('⟨U+200B⟩ '.repeat(300))).toBe(true);
    expect(isLargeFile('small')).toBe(false);
  });

  it('keeps the head of a closed file short without cutting a marker in half', () => {
    const long = `${'x'.repeat(398)}⟨U+202E⟩tail`;
    expect(fileHead(long)).toBe(`${'x'.repeat(398)}⟨U+202E⟩…`);
    expect(fileHead(Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n')).split('\n').length).toBe(40);
  });

  it('opens a closed file a watched warning names by its path', () => {
    const warnings = [{ code: 'carries-scripts', text: 'run.sh is a script' }];
    expect(namedByWarning('run.sh', warnings)).toBe(true);
    expect(namedByWarning('other.md', warnings)).toBe(false);
    expect(namedByWarning('run.sh', [{ code: 'first-publisher', text: 'run.sh' }])).toBe(false);
  });

  it('puts the most serious warning first, never by colour alone, and keeps the daemon’s order among equals', () => {
    const rows = warningRows([
      { code: 'first-publisher', text: 'n' },
      { code: 'carries-scripts', text: 'c1' },
      { code: 'hidden-characters', text: 'h' },
      { code: 'carries-scripts', text: 'c2' },
    ]);
    expect(rows.map(row => [row.code, row.text, row.tone])).toEqual([
      ['hidden-characters', 'h', 'danger'],
      ['carries-scripts', 'c1', 'caution'],
      ['carries-scripts', 'c2', 'caution'],
      ['first-publisher', 'n', 'note'],
    ]);
    expect(rows[0]?.label).toBe('Hidden characters');
  });
});
