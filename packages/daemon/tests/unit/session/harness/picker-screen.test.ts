import { describe, it } from 'bun:test';
import should from 'should';
import { parseCodexPickerScreen, pickerRowFor, pickerStillShows } from '../../../../src/lib/session/harness/index.ts';

const pane = (...lines: readonly string[]): string => lines.join('\n');

const QUICK_PICKER = pane(
  '  Select Model',
  '  1. gpt-5-codex   fast, cheap',
  '› 2. gpt-5.6-terra (current)',
  '  3. All models',
);

describe('parseCodexPickerScreen', () => {
  it('should read the quick model picker with its rows', () => {
    // Arrange / Act
    const screen = parseCodexPickerScreen(QUICK_PICKER);

    // Assert: the second column and the (current) annotation are not part of the
    // selectable name.
    should(screen.kind).eql('quick-models');
    should(screen.title).eql('Select Model');
    should(screen.rows).eql([
      { number: 1, name: 'gpt-5-codex' },
      { number: 2, name: 'gpt-5.6-terra' },
      { number: 3, name: 'All models' },
    ]);
  });

  it.each([
    { line: 'Select Model and Effort', kind: 'all-models' as const },
    { line: 'Select Reasoning Level for gpt-5-codex', kind: 'reasoning' as const },
    { line: 'Advanced Reasoning', kind: 'advanced-reasoning' as const },
    { line: 'Apply reasoning change', kind: 'plan-scope' as const },
    { line: 'Select Model', kind: 'quick-models' as const },
  ])('should classify $line as $kind', ({ line, kind }) => {
    // Arrange / Act
    const screen = parseCodexPickerScreen(pane(line, '  1. only'));

    // Assert
    should(screen.kind).eql(kind);
  });

  it('should report nothing open for an ordinary pane', () => {
    // Arrange / Act
    const screen = parseCodexPickerScreen(pane('$ ls', 'README.md'));

    // Assert
    should(screen).eql({ kind: 'none', rows: [] });
  });

  it('should take the LAST title so scrollback never wins over the live screen', () => {
    // Arrange: an earlier picker is still in the capture above the current one.
    const screen = parseCodexPickerScreen(
      pane('Select Model', '  1. stale', 'Advanced Reasoning', '  1. minimal', '  2. max'),
    );

    // Assert
    should(screen.kind).eql('advanced-reasoning');
    should(screen.rows).eql([
      { number: 1, name: 'minimal' },
      { number: 2, name: 'max' },
    ]);
  });

  it('should refuse a picker whose rows sit above a composer prompt', () => {
    // Arrange: this is the hazard — a title left in scrollback with the harness
    // back at its prompt. Treating those rows as live would send a digit into the
    // conversation.
    const screen = parseCodexPickerScreen(pane('Select Model', '  1. gpt-5-codex', '│ > '));

    // Assert
    should(screen).eql({ kind: 'none', rows: [] });
  });

  it('should still read rows when the line below is a quoted numbered list, not a prompt', () => {
    // Arrange / Act
    const screen = parseCodexPickerScreen(pane('Select Model', '> 1. gpt-5-codex'));

    // Assert
    should(screen.kind).eql('quick-models');
    should(screen.rows).eql([{ number: 1, name: 'gpt-5-codex' }]);
  });

  it.each([
    { name: 'a zero row number', line: '  0. nope' },
    { name: 'a row number too large to be safe', line: `  ${'9'.repeat(25)}. nope` },
    { name: 'an unnumbered line', line: '  gpt-5-codex' },
  ])('should skip $name', ({ line }) => {
    // Arrange / Act
    const screen = parseCodexPickerScreen(pane('Select Model', line, '  1. real'));

    // Assert
    should(screen.rows).eql([{ number: 1, name: 'real' }]);
  });

  it('should strip both a default and a current annotation from one row', () => {
    // Arrange / Act
    const screen = parseCodexPickerScreen(pane('Select Model', '  1. gpt-5-codex (default) (current)'));

    // Assert
    should(screen.rows).eql([{ number: 1, name: 'gpt-5-codex' }]);
  });

  it('should yield an empty name for a row that is only whitespace columns', () => {
    // Arrange: a wrapped or truncated render must not become a name that happens
    // to match something.
    const screen = parseCodexPickerScreen(pane('Select Model', '  1.     '));

    // Assert
    should(screen.rows).eql([{ number: 1, name: '' }]);
  });
});

describe('pickerStillShows', () => {
  it('should confirm a row that is still on the same screen', () => {
    // Arrange / Act / Assert
    should(
      pickerStillShows(QUICK_PICKER, {
        kind: 'quick-models',
        title: 'Select Model',
        row: { number: 1, name: 'gpt-5-codex' },
      }),
    ).eql(true);
  });

  it.each([
    {
      name: 'the screen changed kind',
      kind: 'all-models' as const,
      title: 'Select Model',
      number: 1,
      rowName: 'gpt-5-codex',
    },
    {
      name: 'the title changed',
      kind: 'quick-models' as const,
      title: 'Select Model and Effort',
      number: 1,
      rowName: 'gpt-5-codex',
    },
    { name: 'the row moved', kind: 'quick-models' as const, title: 'Select Model', number: 2, rowName: 'gpt-5-codex' },
    { name: 'the row renamed', kind: 'quick-models' as const, title: 'Select Model', number: 1, rowName: 'gpt-6' },
  ])('should refuse when $name', ({ kind, title, number, rowName }) => {
    // Arrange / Act / Assert
    should(pickerStillShows(QUICK_PICKER, { kind, title, row: { number, name: rowName } })).eql(false);
  });
});

describe('pickerRowFor', () => {
  it('should find the row that selects a named choice', () => {
    // Arrange / Act
    const row = pickerRowFor(parseCodexPickerScreen(QUICK_PICKER), 'All models');

    // Assert
    should(row).eql({ number: 3, name: 'All models' });
  });

  it('should find nothing for a choice the screen does not offer', () => {
    // Arrange / Act / Assert
    should(pickerRowFor(parseCodexPickerScreen(QUICK_PICKER), 'gpt-7')).eql(undefined);
  });
});
