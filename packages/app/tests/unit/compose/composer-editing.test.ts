import { describe, expect, test } from 'bun:test';
import { continueList, insideCodeBlock, toggleWrap } from '../../../src/compose/composer-editing.ts';

describe('continueList', () => {
  test('continues bullets, numbers and checklists, keeping the indent', () => {
    expect(continueList('- a', 3)).toEqual({ value: '- a\n- ', caret: 6 });
    expect(continueList('  * b', 5)).toEqual({ value: '  * b\n  * ', caret: 10 });
    expect(continueList('x\n3. c', 6)).toEqual({ value: 'x\n3. c\n4. ', caret: 10 });
    expect(continueList('[x] done', 8)).toEqual({ value: '[x] done\n[ ] ', caret: 13 });
    expect(continueList('- [x] task', 10)).toEqual({ value: '- [x] task\n- [ ] ', caret: 17 });
  });

  test('ends the list on an empty item, and leaves anything else alone', () => {
    expect(continueList('- a\n- ', 6)).toEqual({ value: '- a\n', caret: 4 });
    expect(continueList('plain', 5)).toBeNull();
    expect(continueList('- a b', 3)).toBeNull();
  });
});

describe('editing helpers', () => {
  test('knows when the caret is inside a code fence', () => {
    expect(insideCodeBlock('```\nconst a', 11)).toBe(true);
    expect(insideCodeBlock('```\na\n```\nb', 11)).toBe(false);
  });

  test('wraps and unwraps a selection, and wraps an empty one around the caret', () => {
    expect(toggleWrap('make bold', 5, 9, '**')).toEqual({ value: 'make **bold**', caret: 13 });
    expect(toggleWrap('make **bold**', 7, 11, '**')).toEqual({ value: 'make bold', caret: 9 });
    expect(toggleWrap('ab', 1, 1, '`')).toEqual({ value: 'a``b', caret: 2 });
  });
});
