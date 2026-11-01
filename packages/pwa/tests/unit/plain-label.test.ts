import { describe, expect, test } from 'bun:test';
import { plainLabel } from '../../src/lib/plain-label.ts';

describe('plainLabel', () => {
  test.each([
    ['**Send now**', 'Send now'],
    ['A **Send now**', 'A Send now'],
    ['B **Wait**', 'B Wait'],
    ['__Wait__', 'Wait'],
    ['*Later*', 'Later'],
    ['_Later_', 'Later'],
    ['`ci` rename', 'ci rename'],
    ['[Spec](https://example.test/spec)', 'Spec'],
    ['~~Old~~ New', 'Old New'],
    ['**Keep** the *old* name', 'Keep the old name'],
  ])('%s reads as %s', (marked, plain) => {
    expect(plainLabel(marked)).toBe(plain);
  });

  test.each(['Send now', 'snake_case_name', '2 * 3', 'Yes', 'Rename to build'])('leaves %s alone', words => {
    expect(plainLabel(words)).toBe(words);
  });

  test('never turns a label into nothing', () => {
    expect(plainLabel('****')).toBe('****');
  });
});
