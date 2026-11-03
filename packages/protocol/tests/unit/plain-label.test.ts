import { describe, it } from 'bun:test';
import should from 'should';
import { plainLabel } from '../../src/lib/plain-label.ts';

describe('plainLabel', () => {
  it.each([
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
  ])('reads %s as %s', (marked, plain) => {
    should(plainLabel(marked)).equal(plain);
  });

  it.each(['Send now', 'snake_case_name', '2 * 3', 'Yes', 'Rename to build'])('leaves %s alone', words => {
    should(plainLabel(words)).equal(words);
  });

  it.each([
    ['A **Send now**', 'A', 'Send now'],
    ['B **Wait**', 'B', 'Wait'],
    ['B Wait', 'B', 'Wait'],
    ['A: Send now', 'A', 'Send now'],
    ['A. Send now', 'A', 'Send now'],
    ['C) Keep both', 'C', 'Keep both'],
    ['**A** Send now', 'A', 'Send now'],
    ['A - Send now', 'A', 'Send now'],
  ])('drops from %s its own letter %s: %s', (marked, letter, plain) => {
    should(plainLabel(marked, letter)).equal(plain);
  });

  it.each([
    ['A new approach', 'A'],
    ['A', 'A'],
    ['B Wait', 'A'],
    ['Apples', 'A'],
    ['A2 plan', 'A'],
    ['Send now', 'A'],
  ])('keeps %s as its own words under letter %s', (words, letter) => {
    should(plainLabel(words, letter)).equal(words);
  });

  it('never turns a label into nothing', () => {
    should(plainLabel('****')).equal('****');
  });
});
